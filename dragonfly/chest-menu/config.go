package chestmenu

import (
	"bytes"
	"errors"
	"fmt"
	"os"
	"strings"

	"github.com/bedrock-gophers/inv/inv"
	_ "github.com/df-mc/dragonfly/server/block" // registers block items, so ItemByName can find them
	_ "github.com/df-mc/dragonfly/server/item"  // registers plain items
	"github.com/df-mc/dragonfly/server/world"
	"github.com/pelletier/go-toml/v2"
)

// Config is a parsed, validated menu file.
type Config struct {
	Menus map[string]*Menu `toml:"menus"`
}

// Menu is one chest menu. Its key in the file is the command that opens it.
type Menu struct {
	Title       string   `toml:"title"`
	Size        string   `toml:"size"`
	Description string   `toml:"description"`
	Aliases     []string `toml:"aliases"`
	Filler      string   `toml:"filler"`
	FillerName  *string  `toml:"filler_name"`
	Previous    Arrow    `toml:"previous"`
	Next        Arrow    `toml:"next"`
	Pages       []Page   `toml:"pages"`

	name      string
	container inv.Container
}

// Arrow is a page-turn button. It only shows when there is a page to turn to.
type Arrow struct {
	Item string   `toml:"item"`
	Name string   `toml:"name"`
	Lore []string `toml:"lore"`
	Slot *int     `toml:"slot"`
}

// Page is one screen of a menu.
type Page struct {
	Items []Button `toml:"items"`
}

// Button is one item in a page, and what clicking it does.
type Button struct {
	Slot  *int     `toml:"slot"`
	Item  string   `toml:"item"`
	Count int      `toml:"count"`
	Meta  int16    `toml:"meta"`
	Name  string   `toml:"name"`
	Lore  []string `toml:"lore"`

	Command string `toml:"command"`
	Message string `toml:"message"`
	Open    string `toml:"open"`
	Close   bool   `toml:"close"`
}

// sizes maps the size names allowed in the file to inv containers.
var sizes = map[string]inv.Container{
	"chest":        inv.ContainerChest{},
	"double_chest": inv.ContainerChest{DoubleChest: true},
	"barrel":       inv.ContainerBarrel{},
	"hopper":       inv.ContainerHopper{},
	"dropper":      inv.ContainerDropper{},
}

// Load reads and validates a menu file. Every problem in the file is reported at once.
func Load(path string) (*Config, error) {
	data, err := os.ReadFile(path)
	if err != nil {
		return nil, err
	}
	return Parse(data)
}

// Parse validates a menu file already in memory.
func Parse(data []byte) (*Config, error) {
	var c Config
	dec := toml.NewDecoder(bytes.NewReader(data))
	dec.DisallowUnknownFields() // catches typos like "comand" instead of silently ignoring them
	if err := dec.Decode(&c); err != nil {
		var strict *toml.StrictMissingError
		if errors.As(err, &strict) {
			return nil, fmt.Errorf("unknown setting in menu file:\n%s", strict.String())
		}
		return nil, fmt.Errorf("menu file: %w", err)
	}
	if err := c.prepare(); err != nil {
		return nil, err
	}
	return &c, nil
}

func (c *Config) prepare() error {
	if len(c.Menus) == 0 {
		return errors.New("menu file defines no menus")
	}
	var problems []string
	add := func(format string, a ...any) { problems = append(problems, fmt.Sprintf(format, a...)) }

	for name, m := range c.Menus {
		where := fmt.Sprintf("menu %q", name)
		if name == "" || strings.ContainsAny(name, " \t/") || strings.ToLower(name) != name {
			add("%s: menu names become commands, so use lowercase with no spaces or slashes", where)
		}
		m.name = name

		if m.Size == "" {
			m.Size = "chest"
		}
		container, ok := sizes[m.Size]
		if !ok {
			add("%s: size %q must be one of chest, double_chest, barrel, hopper, dropper", where, m.Size)
			continue
		}
		m.container = container
		slots := container.Size()

		if m.Title == "" {
			m.Title = name
		}
		if m.Description == "" {
			m.Description = "Opens the " + name + " menu"
		}
		if m.FillerName == nil {
			blank := "§r" // hovering a filler pane shows nothing
			m.FillerName = &blank
		}
		if m.Filler != "" && !itemExists(m.Filler, 0) {
			add("%s: unknown filler item %q", where, m.Filler)
		}
		if len(m.Pages) == 0 {
			add("%s: has no pages", where)
		}

		m.Previous.fill("minecraft:arrow", "§e« Previous page", bottomLeft(slots))
		m.Next.fill("minecraft:arrow", "§eNext page »", slots-1)
		for label, a := range map[string]*Arrow{"previous": &m.Previous, "next": &m.Next} {
			if !itemExists(a.Item, 0) {
				add("%s: unknown %s-arrow item %q", where, label, a.Item)
			}
			if *a.Slot < 0 || *a.Slot >= slots {
				add("%s: %s-arrow slot %d is outside 0-%d", where, label, *a.Slot, slots-1)
			}
		}
		if len(m.Pages) > 1 && *m.Previous.Slot == *m.Next.Slot {
			add("%s: previous and next arrows are both in slot %d", where, *m.Next.Slot)
		}

		for p := range m.Pages {
			page := &m.Pages[p]
			used := map[int]bool{}
			for b := range page.Items {
				btn := &page.Items[b]
				at := fmt.Sprintf("%s page %d item %d", where, p+1, b+1)
				if btn.Slot == nil {
					add("%s: missing slot", at)
					continue
				}
				slot := *btn.Slot
				switch {
				case slot < 0 || slot >= slots:
					add("%s: slot %d is outside 0-%d for a %s", at, slot, slots-1, m.Size)
				case used[slot]:
					add("%s: slot %d is already used on this page", at, slot)
				case p > 0 && slot == *m.Previous.Slot:
					add("%s: slot %d is where the previous-page arrow goes", at, slot)
				case p < len(m.Pages)-1 && slot == *m.Next.Slot:
					add("%s: slot %d is where the next-page arrow goes", at, slot)
				}
				used[slot] = true
				if btn.Count == 0 {
					btn.Count = 1
				}
				if btn.Count < 1 || btn.Count > 64 {
					add("%s: count %d must be 1-64", at, btn.Count)
				}
				if !itemExists(btn.Item, btn.Meta) {
					add("%s: unknown item %q (meta %d)", at, btn.Item, btn.Meta)
				}
				if btn.Open != "" && c.Menus[btn.Open] == nil {
					add("%s: opens menu %q, which isn't defined", at, btn.Open)
				}
			}
		}
	}
	if len(problems) > 0 {
		return fmt.Errorf("menu file has %d problem(s):\n  - %s", len(problems), strings.Join(problems, "\n  - "))
	}
	return nil
}

func (a *Arrow) fill(item, name string, slot int) {
	if a.Item == "" {
		a.Item = item
	}
	if a.Name == "" {
		a.Name = name
	}
	if a.Slot == nil {
		a.Slot = &slot
	}
}

// bottomLeft is the first slot of the last row, for the rows-of-9 containers; small ones use slot 0.
func bottomLeft(slots int) int {
	if slots >= 9 && slots%9 == 0 {
		return slots - 9
	}
	return 0
}

func itemExists(name string, meta int16) bool {
	_, ok := world.ItemByName(name, meta)
	return ok
}
