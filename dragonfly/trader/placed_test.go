package trader

import (
	"context"
	"testing"
	"time"

	"github.com/df-mc/dragonfly/server/entity"
	"github.com/df-mc/dragonfly/server/world"
	"github.com/df-mc/dragonfly/server/world/mcdb"
	"github.com/go-gl/mathgl/mgl64"
)

// After a restart, a trader in a chunk nobody has loaded must still be listed
// and removable by label from far away.
func TestRemovePlacedFromUnloadedChunk(t *testing.T) {
	inTempDir(t)
	Load(nil)
	dir := t.TempDir()
	reg := entity.DefaultRegistry.Config().New(append(entity.DefaultRegistry.Types(), Type))
	open := func() *world.World {
		prov, err := mcdb.Config{}.Open(dir)
		if err != nil {
			t.Fatal(err)
		}
		return world.Config{Entities: reg, Provider: prov, Generator: world.NopGenerator{}}.New()
	}
	run := func(w *world.World, f func(tx *world.Tx)) {
		_, _ = world.Call(context.Background(), w, func(tx *world.Tx) (struct{}, error) { f(tx); return struct{}{}, nil })
	}
	near := mgl64.Vec3{0.5, 10, 0.5}
	far := mgl64.Vec3{800.5, 10, -640.5}

	w := open()
	run(w, func(tx *world.Tx) {
		for _, pos := range []mgl64.Vec3{near, far} {
			if err := Spawn(tx, "example", pos, 0); err != nil {
				t.Fatal(err)
			}
		}
	})
	if err := w.Close(); err != nil {
		t.Fatal(err)
	}
	if got := PlacedLabels(); len(got) != 2 || got[0] != "example_1" || got[1] != "example_2" {
		t.Fatalf("PlacedLabels = %v, want [example_1 example_2]", got)
	}
	if got := PlacedByID()["example"]; len(got) != 2 || got[1] != "example_2 §7at 800, 10, -641" {
		t.Fatalf("PlacedByID()[example] = %q, want the far trader at block 800, 10, -641", got)
	}

	// Restart: the list is read back from trader_placed.json.
	Load(nil)
	w = open()
	defer w.Close()

	result := make(chan RemoveResult, 1)
	run(w, func(tx *world.Tx) {
		if err := RemovePlaced(tx, "example_2", func(_ *world.Tx, r RemoveResult) { result <- r }); err != nil {
			t.Fatal(err)
		}
	})
	select {
	case r := <-result:
		if r.Gone || r.ID != "example" || r.Pos != far {
			t.Fatalf("RemovePlaced result = %+v, want the far trader removed", r)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("RemovePlaced never finished")
	}

	// With one "example" left, its label is just the id.
	if got := PlacedLabels(); len(got) != 1 || got[0] != "example" {
		t.Fatalf("PlacedLabels after remove = %v, want [example]", got)
	}
	run(w, func(tx *world.Tx) {
		for e := range tx.Entities() {
			if _, ok := idOf(e); ok && e.Position().Sub(far).Len() < 2 {
				t.Fatal("far trader still in the world after RemovePlaced")
			}
		}
	})

	run(w, func(tx *world.Tx) {
		if err := RemovePlaced(tx, "example_9", func(*world.Tx, RemoveResult) {}); err == nil {
			t.Fatal("RemovePlaced with an unknown label should fail")
		}
	})
}
