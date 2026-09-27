package trader

import (
	"os"
	"path/filepath"
	"testing"

	"github.com/df-mc/dragonfly/server/item"
)

func inTempDir(t *testing.T) {
	t.Helper()
	wd, _ := os.Getwd()
	dir := t.TempDir()
	if err := os.Chdir(dir); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = os.Chdir(wd) })
}

func TestExampleConfigLoads(t *testing.T) {
	inTempDir(t)
	n, problems := Load(nil)
	if n != 1 || len(problems) != 0 {
		t.Fatalf("Load() = %d traders, problems %v", n, problems)
	}
	if _, err := os.Stat(configFile); err != nil {
		t.Fatalf("example %s not written: %v", configFile, err)
	}
	tr := traders["example"]
	if len(tr.offers) != 3 {
		t.Fatalf("example has %d offers, want 3", len(tr.offers))
	}
	book := tr.offers[1].sell
	if len(book.Enchantments()) != 1 || book.CustomName() != "§bMending" {
		t.Fatalf("enchanted book sell = %v", book)
	}
	if tr.offers[1].buy2.Empty() {
		t.Fatal("offer 2 should have a second payment item")
	}
}

func TestBadOffersAreSkippedNotFatal(t *testing.T) {
	inTempDir(t)
	cfg := `{"traders":{"shop":{"name":"Shop","offers":[
		{"buy":{"item":"diamond","count":1},"sell":{"item":"minecraft:stone","count":64}},
		{"buy":{"item":"minecraft:not_a_real_item","count":1},"sell":{"item":"minecraft:stone","count":1}},
		{"buy":{"item":"minecraft:diamond","count":65},"sell":{"item":"minecraft:stone","count":1}},
		{"buy":{"item":"minecraft:diamond","count":1},"sell":{"item":"minecraft:diamond_sword","count":1,"enchantments":{"not_real":1}}}
	]}}}`
	if err := os.WriteFile(filepath.Join(".", configFile), []byte(cfg), 0o644); err != nil {
		t.Fatal(err)
	}
	n, problems := Load(nil)
	if n != 1 || len(problems) != 3 {
		t.Fatalf("Load() = %d traders, %d problems %v; want 1 trader, 3 problems", n, len(problems), problems)
	}
	if got := len(traders["shop"].offers); got != 1 {
		t.Fatalf("shop kept %d offers, want 1", got)
	}
	if _, ok := traders["shop"].offers[0].buy.Item().(item.Diamond); !ok {
		t.Fatal(`"diamond" without a namespace should resolve to minecraft:diamond`)
	}
}

func TestUsesLimitAndRestock(t *testing.T) {
	inTempDir(t)
	Load(nil)
	tr := &trader{def: Def{RestockMinutes: 1}, offers: make([]offer, 2)}
	c := countsFor("x", tr, "p1")
	c[0] = 3
	if countsFor("x", tr, "p1")[0] != 3 {
		t.Fatal("counts not kept")
	}
	if countsFor("x", tr, "p2")[0] != 0 {
		t.Fatal("counts should be per key")
	}
	uses["x"].RestockedAt -= 61
	if countsFor("x", tr, "p1")[0] != 0 {
		t.Fatal("restock did not reset counts")
	}
}
