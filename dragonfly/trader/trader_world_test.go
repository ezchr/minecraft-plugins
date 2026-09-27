package trader

import (
	"context"
	"testing"

	"github.com/df-mc/dragonfly/server/entity"
	"github.com/df-mc/dragonfly/server/world"
	"github.com/go-gl/mathgl/mgl64"
)

func TestSpawnAndRemove(t *testing.T) {
	inTempDir(t)
	Load(nil)
	reg := entity.DefaultRegistry.Config().New(append(entity.DefaultRegistry.Types(), Type))
	w := world.Config{Entities: reg, Provider: world.NopProvider{}, Generator: world.NopGenerator{}}.New()
	defer w.Close()
	run := func(f func(tx *world.Tx)) {
		_, _ = world.Call(context.Background(), w, func(tx *world.Tx) (struct{}, error) { f(tx); return struct{}{}, nil })
	}

	run(func(tx *world.Tx) {
		if err := Spawn(tx, "example", mgl64.Vec3{0.5, 10, 0.5}, 0); err != nil {
			t.Fatal(err)
		}
	})
	run(func(tx *world.Tx) {
		n := 0
		for e := range tx.Entities() {
			if _, ok := idOf(e); ok {
				n++
			}
		}
		if n != 1 {
			t.Fatalf("%d traders after Spawn, want 1", n)
		}
		id, ok := RemoveNearest(tx, mgl64.Vec3{2, 10, 2}, 6)
		if !ok || id != "example" {
			t.Fatalf("RemoveNearest = %q, %v", id, ok)
		}
	})
	run(func(tx *world.Tx) {
		for e := range tx.Entities() {
			if _, ok := idOf(e); ok {
				t.Fatal("trader still present after RemoveNearest")
			}
		}
	})
}
