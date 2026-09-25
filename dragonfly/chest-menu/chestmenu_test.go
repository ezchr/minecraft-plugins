package chestmenu

import (
	"os"
	"strings"
	"testing"

	"github.com/df-mc/dragonfly/server/item"
)

func loadExample(t *testing.T) *Config {
	t.Helper()
	data, err := os.ReadFile("menus.example.toml")
	if err != nil {
		t.Fatal(err)
	}
	c, err := Parse(data)
	if err != nil {
		t.Fatalf("example config should be valid: %v", err)
	}
	return c
}

func buttonRef(t *testing.T, st item.Stack) string {
	t.Helper()
	v, ok := st.Value(buttonKey)
	if !ok {
		return ""
	}
	return v.(string)
}

func TestExampleLoads(t *testing.T) {
	c := loadExample(t)
	if len(c.Menus) != 2 {
		t.Fatalf("want 2 menus, got %d", len(c.Menus))
	}
	shop := c.Menus["shop"]
	if shop.container.Size() != 27 || len(shop.Pages) != 2 {
		t.Fatalf("shop: size %d pages %d", shop.container.Size(), len(shop.Pages))
	}
	if c.Menus["warps"].container.Size() != 5 {
		t.Fatalf("warps should be a 5-slot hopper")
	}
}

func TestPageLayout(t *testing.T) {
	shop := loadExample(t).Menus["shop"]

	first := shop.stacks("Steve", 0)
	if len(first) != 27 {
		t.Fatalf("page 1 has %d slots", len(first))
	}
	if buttonRef(t, first[18]) != "" {
		t.Error("page 1 must not show a previous arrow")
	}
	if buttonRef(t, first[26]) != "shop|0|next|26" {
		t.Errorf("page 1 next arrow ref = %q", buttonRef(t, first[26]))
	}
	if buttonRef(t, first[11]) != "shop|0|item|11" {
		t.Errorf("sword ref = %q", buttonRef(t, first[11]))
	}
	if first[13].Count() != 16 {
		t.Errorf("emerald count = %d", first[13].Count())
	}
	if !strings.Contains(strings.Join(first[13].Lore(), " "), "Hi Steve!") {
		t.Errorf("{player} not filled in lore: %v", first[13].Lore())
	}
	if first[0].Empty() || buttonRef(t, first[0]) != "" {
		t.Error("slot 0 should be untagged filler")
	}

	second := shop.stacks("Steve", 1)
	if buttonRef(t, second[18]) != "shop|1|prev|18" {
		t.Errorf("page 2 prev arrow ref = %q", buttonRef(t, second[18]))
	}
	if buttonRef(t, second[26]) != "" {
		t.Error("last page must not show a next arrow")
	}
}

func TestTitlePlaceholders(t *testing.T) {
	shop := loadExample(t).Menus["shop"]
	if got := shop.fill(shop.Title, "Steve", 1); !strings.Contains(got, "(2/2)") {
		t.Errorf("title = %q", got)
	}
}

func TestRefRoundTrip(t *testing.T) {
	menu, page, kind, slot, ok := parseRef(ref("shop", 3, "item", 22))
	if !ok || menu != "shop" || page != 3 || kind != "item" || slot != 22 {
		t.Fatalf("got %q %d %q %d %v", menu, page, kind, slot, ok)
	}
	if _, _, _, _, ok := parseRef("garbage"); ok {
		t.Error("garbage should not parse")
	}
}

func TestValidationReportsEveryProblem(t *testing.T) {
	bad := `
[menus.Shop]
size = "barrel_of_fun"

[menus.good]
[menus.good.next]
slot = 99
[[menus.good.pages]]
[[menus.good.pages.items]]
slot = 11
item = "minecraft:not_a_real_item"
[[menus.good.pages.items]]
slot = 11
item = "minecraft:diamond"
open = "nowhere"
[[menus.good.pages.items]]
item = "minecraft:diamond"
[[menus.good.pages]]
`
	_, err := Parse([]byte(bad))
	if err == nil {
		t.Fatal("expected errors")
	}
	for _, want := range []string{
		"lowercase",       // menu name "Shop"
		"barrel_of_fun",   // bad size
		"slot 99",         // arrow out of range
		"not_a_real_item", // unknown item
		"already used",    // duplicate slot 11
		"nowhere",         // open target missing
		"missing slot",    // item without slot
	} {
		if !strings.Contains(err.Error(), want) {
			t.Errorf("error should mention %q:\n%v", want, err)
		}
	}
}

func TestUnknownSettingIsRejected(t *testing.T) {
	typo := `
[menus.shop]
[[menus.shop.pages]]
[[menus.shop.pages.items]]
slot = 0
item = "minecraft:diamond"
comand = "say hi"
`
	_, err := Parse([]byte(typo))
	if err == nil || !strings.Contains(err.Error(), "comand") {
		t.Fatalf("a misspelt setting should be reported, got %v", err)
	}
}
