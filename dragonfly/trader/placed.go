package trader

// Placed traders. The world saves trader entities, but only loaded chunks
// can be searched, so trader_placed.json keeps where each one is: /trader
// remove <trader> can then suggest them by label and remove one from any
// distance by loading its chunk first. Traders placed before the list
// existed are added the first time anyone right-clicks them.

import (
	"encoding/json"
	"fmt"
	"os"
	"strconv"
	"strings"

	"github.com/df-mc/dragonfly/server/block/cube"
	"github.com/df-mc/dragonfly/server/entity"
	"github.com/df-mc/dragonfly/server/world"
	"github.com/go-gl/mathgl/mgl64"
)

const placedFile = "trader_placed.json"

// samePlaceDist is how close a trader entity must be to a recorded position
// to count as that trader. Traders never move, so this is only slack for
// rounding.
const samePlaceDist = 1.5

type placedTrader struct {
	ID  string     `json:"id"`
	Pos mgl64.Vec3 `json:"pos"`
	Dim int        `json:"dim"`
}

// placed is guarded by mu.
var placed []placedTrader

// loadPlaced reads trader_placed.json. mu must be held.
func loadPlaced() []string {
	placed = nil
	b, err := os.ReadFile(placedFile)
	if err != nil {
		return nil
	}
	if err := json.Unmarshal(b, &placed); err != nil {
		placed = nil
		return []string{placedFile + " unreadable, placed-trader list reset: " + err.Error()}
	}
	return nil
}

// savePlaced writes trader_placed.json. mu must be held.
func savePlaced() {
	b, err := json.MarshalIndent(placed, "", "  ")
	if err != nil {
		return
	}
	tmp := placedFile + ".tmp"
	if err := os.WriteFile(tmp, b, 0o644); err != nil {
		log.Error("trader: save placed: " + err.Error())
		return
	}
	_ = os.Rename(tmp, placedFile)
}

func dimID(tx *world.Tx) int {
	id, _ := world.DimensionID(tx.World().Dimension())
	return id
}

// indexAt returns the entry for trader id near pos. mu must be held.
func indexAt(id string, pos mgl64.Vec3, dim int) int {
	for i, p := range placed {
		if p.ID == id && p.Dim == dim && p.Pos.Sub(pos).Len() <= samePlaceDist {
			return i
		}
	}
	return -1
}

// recordPlaced adds a trader to the list unless it is already in it.
func recordPlaced(id string, pos mgl64.Vec3, dim int) {
	mu.Lock()
	defer mu.Unlock()
	if indexAt(id, pos, dim) >= 0 {
		return
	}
	placed = append(placed, placedTrader{ID: id, Pos: pos, Dim: dim})
	savePlaced()
}

// forgetPlaced drops the list entry for trader id near pos, if any.
func forgetPlaced(id string, pos mgl64.Vec3, dim int) {
	mu.Lock()
	defer mu.Unlock()
	if i := indexAt(id, pos, dim); i >= 0 {
		placed = append(placed[:i], placed[i+1:]...)
		savePlaced()
	}
}

// labels returns one label per list entry, in order: the trader id, with a
// number ("example_2") only when several placed traders share the id. mu
// must be held.
func labels() []string {
	total := map[string]int{}
	for _, p := range placed {
		total[p.ID]++
	}
	n := map[string]int{}
	out := make([]string, len(placed))
	for i, p := range placed {
		n[p.ID]++
		out[i] = p.ID
		if total[p.ID] > 1 {
			out[i] += "_" + strconv.Itoa(n[p.ID])
		}
	}
	return out
}

// PlacedLabels returns the labels of all placed traders, for suggestions.
func PlacedLabels() []string {
	mu.Lock()
	defer mu.Unlock()
	return labels()
}

// PlacedByID returns, per trader id, one line per placed trader of that id
// with its label and coordinates, for /trader list.
func PlacedByID() map[string][]string {
	mu.Lock()
	defer mu.Unlock()
	lb := labels()
	out := map[string][]string{}
	for i, p := range placed {
		dim := ""
		if p.Dim != 0 {
			d, _ := world.DimensionByID(p.Dim)
			dim = fmt.Sprintf(" (%v)", d)
		}
		b := cube.PosFromVec3(p.Pos) // block coordinates, as the F3 screen shows them
		out[p.ID] = append(out[p.ID], fmt.Sprintf("%s §7at %d, %d, %d%s", lb[i], b.X(), b.Y(), b.Z(), dim))
	}
	return out
}

// RemoveResult reports what RemovePlaced did.
type RemoveResult struct {
	ID  string
	Pos mgl64.Vec3
	// Gone is true when no trader entity was found at the recorded spot any
	// more; the list entry was dropped anyway.
	Gone bool
}

// RemovePlaced removes the placed trader with the given label, from any
// distance. When its chunk is not loaded yet it is loaded and the removal
// finishes on the next tick, so done may run after RemovePlaced returns.
func RemovePlaced(tx *world.Tx, label string, done func(*world.Tx, RemoveResult)) error {
	mu.Lock()
	idx := -1
	for i, l := range labels() {
		if strings.EqualFold(l, strings.TrimSpace(label)) {
			idx = i
			break
		}
	}
	if idx < 0 {
		mu.Unlock()
		return fmt.Errorf("no placed trader called %q - see /trader list", label)
	}
	p := placed[idx]
	mu.Unlock()

	if p.Dim != dimID(tx) {
		d, _ := world.DimensionByID(p.Dim)
		return fmt.Errorf("trader %s is in the %v - run this from there", label, d)
	}
	if removeAt(tx, p) {
		done(tx, RemoveResult{ID: p.ID, Pos: p.Pos})
		return nil
	}
	if _, loaded := tx.BlockLoaded(cube.PosFromVec3(p.Pos)); loaded {
		forgetPlaced(p.ID, p.Pos, p.Dim)
		done(tx, RemoveResult{ID: p.ID, Pos: p.Pos, Gone: true})
		return nil
	}
	// Loading the chunk adds its entities from the next transaction on.
	tx.Block(cube.PosFromVec3(p.Pos))
	tx.World().DoAfter(0, func(tx *world.Tx) {
		gone := !removeAt(tx, p)
		if gone {
			forgetPlaced(p.ID, p.Pos, p.Dim)
		}
		done(tx, RemoveResult{ID: p.ID, Pos: p.Pos, Gone: gone})
	})
	return nil
}

// removeAt removes the trader entity for list entry p if it is in a loaded
// chunk, and drops the entry. It reports whether an entity was removed.
func removeAt(tx *world.Tx, p placedTrader) bool {
	r := samePlaceDist
	box := cube.Box(p.Pos[0]-r, p.Pos[1]-r, p.Pos[2]-r, p.Pos[0]+r, p.Pos[1]+r, p.Pos[2]+r)
	for e := range tx.EntitiesWithin(box) {
		if id, ok := idOf(e); ok && id == p.ID {
			_ = e.(*entity.Ent).Close()
			forgetPlaced(p.ID, p.Pos, p.Dim)
			return true
		}
	}
	return false
}
