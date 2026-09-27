// Package trader: stationary villager NPCs that open the vanilla trading
// window, with every offer defined in traders.json.
//
// traders.json maps a trader id to its definition:
//
//	{
//	  "traders": {
//	    "blacksmith": {
//	      "name": "§6Blacksmith",
//	      "limitPer": "player",      // "player" (default) or "global"
//	      "restockMinutes": 60,      // 0 or omitted = never restocks
//	      "offers": [
//	        {
//	          "buy":  { "item": "minecraft:iron_ingot", "count": 10 },
//	          "buy2": { "item": "minecraft:coal", "count": 4 },     // optional
//	          "sell": { "item": "minecraft:iron_sword", "count": 1,
//	                    "name": "§bSharp Sword", "lore": ["line"],
//	                    "enchantments": { "sharpness": 2 } },
//	          "maxUses": 5            // 0 or omitted = unlimited
//	        }
//	      ]
//	    }
//	  }
//	}
//
// Any item works on either side of a trade - there is no emerald rule.
// "meta", "name", "lore" and "enchantments" are optional on every item.
//
// Placed traders are real world entities of a registered type (zid:trader),
// saved with the world like any other entity; each remembers only its trader
// id. Offers are looked up by that id every time the window opens, so editing
// traders.json and running /trader reload takes effect without a restart.
// Trade counts live in trader_uses.json.
package trader

import (
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"os"
	"sort"
	"strings"
	"sync"
	"time"

	"github.com/df-mc/dragonfly/server/block/cube"
	"github.com/df-mc/dragonfly/server/entity"
	"github.com/df-mc/dragonfly/server/item"
	"github.com/df-mc/dragonfly/server/player"
	"github.com/df-mc/dragonfly/server/session"
	"github.com/df-mc/dragonfly/server/world"
	"github.com/go-gl/mathgl/mgl64"
)

const (
	configFile = "traders.json"
	stateFile  = "trader_uses.json"
	globalKey  = "global"
)

// --- config format ---------------------------------------------------------

// ItemSpec is one item stack in traders.json.
type ItemSpec struct {
	Item         string         `json:"item"`
	Meta         int16          `json:"meta,omitempty"`
	Count        int            `json:"count"`
	Name         string         `json:"name,omitempty"`
	Lore         []string       `json:"lore,omitempty"`
	Enchantments map[string]int `json:"enchantments,omitempty"`
}

// OfferSpec is one trade in traders.json.
type OfferSpec struct {
	Buy     ItemSpec  `json:"buy"`
	Buy2    *ItemSpec `json:"buy2,omitempty"`
	Sell    ItemSpec  `json:"sell"`
	MaxUses int       `json:"maxUses,omitempty"`
}

// Def is one trader in traders.json.
type Def struct {
	Name           string      `json:"name"`
	LimitPer       string      `json:"limitPer,omitempty"`
	RestockMinutes int         `json:"restockMinutes,omitempty"`
	Offers         []OfferSpec `json:"offers"`
}

type fileFormat struct {
	Traders map[string]Def `json:"traders"`
}

var example = fileFormat{Traders: map[string]Def{
	"example": {
		Name:           "§6Example Trader",
		LimitPer:       "player",
		RestockMinutes: 60,
		Offers: []OfferSpec{
			{Buy: ItemSpec{Item: "minecraft:iron_ingot", Count: 10}, Sell: ItemSpec{Item: "minecraft:diamond", Count: 1}, MaxUses: 5},
			{
				Buy:     ItemSpec{Item: "minecraft:diamond", Count: 3},
				Buy2:    &ItemSpec{Item: "minecraft:book", Count: 1},
				Sell:    ItemSpec{Item: "minecraft:enchanted_book", Count: 1, Name: "§bMending", Enchantments: map[string]int{"mending": 1}},
				MaxUses: 1,
			},
			{Buy: ItemSpec{Item: "minecraft:cobblestone", Count: 64}, Sell: ItemSpec{Item: "minecraft:emerald", Count: 1}},
		},
	},
}}

// --- loaded state -------------------------------------------------------------

type offer struct {
	buy, buy2, sell item.Stack
	maxUses         int
}

type trader struct {
	def    Def
	offers []offer
}

type useState struct {
	RestockedAt int64            `json:"restockedAt"`
	Uses        map[string][]int `json:"uses"`
}

var (
	mu      sync.Mutex
	traders = map[string]*trader{}
	uses    = map[string]*useState{}
	log     = slog.Default()
)

// Load reads traders.json (writing an example file if there is none) and
// trader_uses.json. It returns one line per problem found; bad offers are
// skipped, not fatal.
func Load(l *slog.Logger) (int, []string) {
	if l != nil {
		log = l
	}
	if _, err := os.Stat(configFile); errors.Is(err, os.ErrNotExist) {
		b, _ := json.MarshalIndent(example, "", "  ")
		_ = os.WriteFile(configFile, b, 0o644)
	}
	b, err := os.ReadFile(configFile)
	if err != nil {
		return 0, []string{"read " + configFile + ": " + err.Error()}
	}
	var f fileFormat
	if err := json.Unmarshal(b, &f); err != nil {
		return 0, []string{configFile + " is not valid JSON: " + err.Error()}
	}

	var problems []string
	loaded := make(map[string]*trader, len(f.Traders))
	for id, def := range f.Traders {
		t := &trader{def: def}
		for i, o := range def.Offers {
			where := fmt.Sprintf("%s offer %d", id, i+1)
			buy, err := o.Buy.stack()
			if err != nil {
				problems = append(problems, where+" buy: "+err.Error())
				continue
			}
			var buy2 item.Stack
			if o.Buy2 != nil {
				if buy2, err = o.Buy2.stack(); err != nil {
					problems = append(problems, where+" buy2: "+err.Error())
					continue
				}
			}
			sell, err := o.Sell.stack()
			if err != nil {
				problems = append(problems, where+" sell: "+err.Error())
				continue
			}
			t.offers = append(t.offers, offer{buy: buy, buy2: buy2, sell: sell, maxUses: o.MaxUses})
		}
		loaded[id] = t
	}

	st := map[string]*useState{}
	if b, err := os.ReadFile(stateFile); err == nil {
		if err := json.Unmarshal(b, &st); err != nil {
			problems = append(problems, stateFile+" unreadable, trade counts reset: "+err.Error())
			st = map[string]*useState{}
		}
	}

	mu.Lock()
	traders, uses = loaded, st
	problems = append(problems, loadPlaced()...)
	mu.Unlock()
	for _, p := range problems {
		log.Warn("trader: " + p)
	}
	return len(loaded), problems
}

func (s ItemSpec) stack() (item.Stack, error) {
	name := s.Item
	if name == "" {
		return item.Stack{}, errors.New(`missing "item"`)
	}
	if !strings.Contains(name, ":") {
		name = "minecraft:" + name
	}
	it, ok := world.ItemByName(name, s.Meta)
	if !ok {
		return item.Stack{}, fmt.Errorf("unknown item %q (meta %d)", name, s.Meta)
	}
	count := s.Count
	if count <= 0 {
		count = 1
	}
	st := item.NewStack(it, count)
	if count > st.MaxCount() {
		return item.Stack{}, fmt.Errorf("count %d is more than %s stacks to (%d)", count, name, st.MaxCount())
	}
	if s.Name != "" {
		st = st.WithCustomName(s.Name)
	}
	if len(s.Lore) > 0 {
		st = st.WithLore(s.Lore...)
	}
	for ench, lvl := range s.Enchantments {
		t, ok := enchantmentByName(ench)
		if !ok {
			return item.Stack{}, fmt.Errorf("unknown enchantment %q", ench)
		}
		st = st.WithEnchantments(item.NewEnchantment(t, lvl))
	}
	return st, nil
}

var (
	enchOnce   sync.Once
	enchByName map[string]item.EnchantmentType
)

func enchantmentByName(name string) (item.EnchantmentType, bool) {
	enchOnce.Do(func() {
		enchByName = map[string]item.EnchantmentType{}
		for _, t := range item.Enchantments() {
			enchByName[strings.ToLower(strings.ReplaceAll(t.Name(), " ", "_"))] = t
		}
	})
	t, ok := enchByName[strings.ToLower(strings.TrimPrefix(name, "minecraft:"))]
	return t, ok
}

// IDs returns the defined trader ids, sorted.
func IDs() []string {
	mu.Lock()
	defer mu.Unlock()
	ids := make([]string, 0, len(traders))
	for id := range traders {
		ids = append(ids, id)
	}
	sort.Strings(ids)
	return ids
}

// Describe returns a one-line summary of a trader, for /trader list.
func Describe(id string) string {
	mu.Lock()
	defer mu.Unlock()
	t, ok := traders[id]
	if !ok {
		return id + " (not defined)"
	}
	limit := t.def.LimitPer
	if limit == "" {
		limit = "player"
	}
	restock := "never restocks"
	if t.def.RestockMinutes > 0 {
		restock = fmt.Sprintf("restocks every %dm", t.def.RestockMinutes)
	}
	return fmt.Sprintf("%s §r- %s §7(%d offers, limits per %s, %s)", id, t.def.Name, len(t.offers), limit, restock)
}

// --- entity ----------------------------------------------------------------

// Type is the entity type of placed traders. Register it in the server's
// entity registry so placed traders are saved and loaded with the world.
var Type traderType

type traderType struct{}

func (traderType) Open(tx *world.Tx, h *world.EntityHandle, d *world.EntityData) world.Entity {
	return entity.Open(tx, h, d)
}
func (traderType) EncodeEntity() string        { return "zid:trader" }
func (traderType) NetworkEncodeEntity() string { return "minecraft:villager_v2" }
func (traderType) BBox(world.Entity) cube.BBox { return cube.Box(-0.3, 0, -0.3, 0.3, 1.95, 0.3) }
func (traderType) DecodeNBT(m map[string]any, d *world.EntityData) {
	id, _ := m["TraderID"].(string)
	d.Data = newBehaviour(id)
}
func (traderType) EncodeNBT(d *world.EntityData) map[string]any {
	if b, ok := d.Data.(*behaviour); ok {
		return map[string]any{"TraderID": b.id}
	}
	return nil
}

// behaviour keeps a trader in place and remembers which trader it is.
type behaviour struct {
	*entity.StationaryBehaviour
	id string
}

func newBehaviour(id string) *behaviour {
	return &behaviour{StationaryBehaviour: entity.StationaryBehaviourConfig{}.New(), id: id}
}

type config struct{ id string }

func (c config) Apply(d *world.EntityData) { d.Data = newBehaviour(c.id) }

// idOf returns the trader id of e, if e is a placed trader.
func idOf(e world.Entity) (string, bool) {
	if e.H().Type() != Type {
		return "", false
	}
	ent, ok := e.(*entity.Ent)
	if !ok {
		return "", false
	}
	b, ok := ent.Behaviour().(*behaviour)
	if !ok {
		return "", false
	}
	return b.id, true
}

// Spawn places a trader with the given id at pos, facing yaw.
func Spawn(tx *world.Tx, id string, pos mgl64.Vec3, yaw float64) error {
	mu.Lock()
	t, ok := traders[id]
	mu.Unlock()
	if !ok {
		return fmt.Errorf("no trader %q in %s", id, configFile)
	}
	h := world.EntitySpawnOpts{Position: pos, Rotation: cube.Rotation{yaw, 0}, NameTag: t.def.Name}.New(Type, config{id: id})
	tx.AddEntity(h)
	recordPlaced(id, pos, dimID(tx))
	return nil
}

// RemoveNearest removes the closest placed trader within radius of pos and
// returns its id.
func RemoveNearest(tx *world.Tx, pos mgl64.Vec3, radius float64) (string, bool) {
	var best world.Entity
	bestID, bestDist := "", radius
	box := cube.Box(pos[0]-radius, pos[1]-radius, pos[2]-radius, pos[0]+radius, pos[1]+radius, pos[2]+radius)
	for e := range tx.EntitiesWithin(box) {
		id, ok := idOf(e)
		if !ok {
			continue
		}
		if d := e.Position().Sub(pos).Len(); d <= bestDist {
			best, bestID, bestDist = e, id, d
		}
	}
	if best == nil {
		return "", false
	}
	forgetPlaced(bestID, best.Position(), dimID(tx))
	_ = best.(*entity.Ent).Close()
	return bestID, true
}

// RefreshNames updates the name tags of placed traders near pos to match
// traders.json (the name is stored on the entity when it is placed).
func RefreshNames(tx *world.Tx, pos mgl64.Vec3, radius float64) int {
	n := 0
	box := cube.Box(pos[0]-radius, pos[1]-radius, pos[2]-radius, pos[0]+radius, pos[1]+radius, pos[2]+radius)
	for e := range tx.EntitiesWithin(box) {
		id, ok := idOf(e)
		if !ok {
			continue
		}
		mu.Lock()
		t, ok := traders[id]
		mu.Unlock()
		if ok {
			e.(*entity.Ent).SetNameTag(t.def.Name)
			n++
		}
	}
	return n
}

// --- trading ---------------------------------------------------------------

// Interact opens the trading window if e is a placed trader. It reports
// whether e was a trader (the caller should then cancel the normal use).
func Interact(p *player.Player, e world.Entity) bool {
	id, ok := idOf(e)
	if !ok {
		return false
	}
	// Traders placed before trader_placed.json existed join the list here.
	recordPlaced(id, e.Position(), dimID(p.Tx()))
	mu.Lock()
	t, ok := traders[id]
	if !ok {
		mu.Unlock()
		p.Message(fmt.Sprintf("§cThis trader (%s) is not defined in %s.", id, configFile))
		return true
	}
	if len(t.offers) == 0 {
		mu.Unlock()
		p.Message("§cThis trader has no offers.")
		return true
	}
	key := usesKey(t, p)
	counts := countsFor(id, t, key)
	offers := make([]session.TradeOffer, len(t.offers))
	for i, o := range t.offers {
		offers[i] = session.TradeOffer{Buy: o.buy, Buy2: o.buy2, Sell: o.sell, MaxUses: o.maxUses, Uses: counts[i]}
	}
	mu.Unlock()

	p.OpenTrade(e, t.def.Name, offers, func(index, times int) bool {
		mu.Lock()
		defer mu.Unlock()
		// traders.json may have been reloaded while the window was open.
		if traders[id] != t || index >= len(t.offers) {
			return false
		}
		c := countsFor(id, t, key)
		if max := t.offers[index].maxUses; max > 0 && c[index]+times > max {
			return false
		}
		c[index] += times
		saveUses()
		return true
	})
	return true
}

func usesKey(t *trader, p *player.Player) string {
	if strings.EqualFold(t.def.LimitPer, globalKey) {
		return globalKey
	}
	if x := p.XUID(); x != "" {
		return x
	}
	return p.Name()
}

// countsFor returns the live use counts of one trader for one key, applying
// a restock first if one is due. mu must be held.
func countsFor(id string, t *trader, key string) []int {
	st, ok := uses[id]
	if !ok {
		st = &useState{RestockedAt: time.Now().Unix(), Uses: map[string][]int{}}
		uses[id] = st
	}
	if t.def.RestockMinutes > 0 && time.Since(time.Unix(st.RestockedAt, 0)) >= time.Duration(t.def.RestockMinutes)*time.Minute {
		st.RestockedAt = time.Now().Unix()
		st.Uses = map[string][]int{}
	}
	c := st.Uses[key]
	if len(c) < len(t.offers) {
		c = append(c, make([]int, len(t.offers)-len(c))...)
		st.Uses[key] = c
	}
	return c
}

// saveUses writes trader_uses.json. mu must be held.
func saveUses() {
	b, err := json.MarshalIndent(uses, "", "  ")
	if err != nil {
		return
	}
	tmp := stateFile + ".tmp"
	if err := os.WriteFile(tmp, b, 0o644); err != nil {
		log.Error("trader: save uses: " + err.Error())
		return
	}
	_ = os.Rename(tmp, stateFile)
}
