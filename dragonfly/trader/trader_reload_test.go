package trader

import (
	"context"
	"testing"

	"github.com/df-mc/dragonfly/server/block/cube"
	"github.com/df-mc/dragonfly/server/entity"
	"github.com/df-mc/dragonfly/server/world"
	"github.com/df-mc/dragonfly/server/world/mcdb"
	"github.com/go-gl/mathgl/mgl64"
)

// A placed trader is saved with the world; after a restart it must still be
// found (and removable) by the commands.
func TestTraderSurvivesReloadAndCanBeRemoved(t *testing.T) {
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
	pos := mgl64.Vec3{0.5, 10, 0.5}

	w := open()
	run(w, func(tx *world.Tx) {
		if err := Spawn(tx, "example", pos, 90); err != nil {
			t.Fatal(err)
		}
	})
	if err := w.Close(); err != nil {
		t.Fatal(err)
	}

	w = open()
	defer w.Close()
	run(w, func(tx *world.Tx) {
		tx.Block(cube.PosFromVec3(pos)) // load the chunk, and its entities
	})
	run(w, func(tx *world.Tx) {
		var ids []string
		for e := range tx.Entities() {
			if id, ok := idOf(e); ok {
				ids = append(ids, id)
			}
		}
		if len(ids) != 1 || ids[0] != "example" {
			t.Fatalf("after reload found traders %v, want [example]", ids)
		}
		if id, ok := RemoveNearest(tx, pos.Add(mgl64.Vec3{2, 0, 2}), 6); !ok || id != "example" {
			t.Fatalf("RemoveNearest after reload = %q, %v", id, ok)
		}
	})
}
