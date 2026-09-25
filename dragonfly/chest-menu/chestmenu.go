// Package chestmenu adds chest-style menus to a Dragonfly server, configured from a TOML file.
//
// Each menu in the file becomes a command. A menu has pages of item "buttons"; arrows turn pages,
// and a button can run a command, send a message, open another menu or close the chest. Players
// can never take the items - the underlying inv library cancels every take.
//
// Setup (see README.md): wrap your listeners with intercept, then call Load and Register.
package chestmenu

import (
	"errors"
	"fmt"
	"log/slog"
	"strconv"
	"strings"
	"sync/atomic"

	"github.com/bedrock-gophers/inv/inv"
	"github.com/df-mc/dragonfly/server/cmd"
	"github.com/df-mc/dragonfly/server/item"
	"github.com/df-mc/dragonfly/server/player"
	"github.com/df-mc/dragonfly/server/world"
)

// Options customises how menus behave. The zero value lets everyone open every menu.
type Options struct {
	// Allow decides whether p may open the named menu (by command or via another menu's button).
	// Nil allows everyone.
	Allow func(p *player.Player, menu string) bool
	// Log receives load/reload messages. Nil uses slog.Default().
	Log *slog.Logger
}

var (
	current atomic.Pointer[Config]
	options atomic.Pointer[Options]
)

// Register adds one command per menu in c, and makes c the live configuration. Call it once, after
// Load. Menu names are fixed after this (Dragonfly can't unregister commands); use Reload to change
// what the menus contain.
func Register(c *Config, opts Options) {
	if opts.Log == nil {
		opts.Log = slog.Default()
	}
	options.Store(&opts)
	current.Store(c)
	for name, m := range c.Menus {
		cmd.Register(cmd.New(name, m.Description, m.Aliases, openCommand{menu: name}))
	}
	opts.Log.Info("chestmenu: registered menus", "count", len(c.Menus))
}

// Reload loads path and swaps it in for the menus already registered. Menus that weren't in the
// file passed to Register can't be added this way - they need a restart.
func Reload(path string) error {
	c, err := Load(path)
	if err != nil {
		return err
	}
	old := current.Load()
	if old == nil {
		return errors.New("chestmenu: Reload called before Register")
	}
	for name := range c.Menus {
		if old.Menus[name] == nil {
			return fmt.Errorf("chestmenu: menu %q is new - adding a menu needs a restart", name)
		}
	}
	current.Store(c)
	opts().Log.Info("chestmenu: reloaded menus", "path", path)
	return nil
}

// Open opens the named menu for p, as if they had run its command.
func Open(p *player.Player, name string) error {
	c := current.Load()
	if c == nil {
		return errors.New("chestmenu: not registered")
	}
	m := c.Menus[name]
	if m == nil {
		return fmt.Errorf("chestmenu: no menu named %q", name)
	}
	if allow := opts().Allow; allow != nil && !allow(p, name) {
		return fmt.Errorf("chestmenu: %s may not open %q", p.Name(), name)
	}
	inv.SendMenu(p, m.build(p.Name(), 0))
	return nil
}

func opts() *Options {
	if o := options.Load(); o != nil {
		return o
	}
	return &Options{Log: slog.Default()}
}

// --- the command ---------------------------------------------------------------------------

type openCommand struct {
	menu string // unexported, so Dragonfly doesn't treat it as a command argument
}

func (c openCommand) Run(src cmd.Source, o *cmd.Output, _ *world.Tx) {
	p, ok := src.(*player.Player)
	if !ok {
		o.Error("Only players can open menus.")
		return
	}
	if err := Open(p, c.menu); err != nil {
		o.Error("You can't open that menu.")
	}
}

// Allow hides the command from players Options.Allow turns away.
func (c openCommand) Allow(src cmd.Source) bool {
	p, ok := src.(*player.Player)
	if !ok {
		return false
	}
	allow := opts().Allow
	return allow == nil || allow(p, c.menu)
}

// --- building a page -----------------------------------------------------------------------

// buttonKey tags every button with where it came from, so clicks are routed by this hidden value
// and never by display names - two buttons may look identical.
const buttonKey = "chestmenu:button"

// build is the inv menu for one page, as seen by the player named who.
func (m *Menu) build(who string, page int) inv.Menu {
	return inv.NewMenu(router{}, m.fill(m.Title, who, page), m.container).WithStacks(m.stacks(who, page)...)
}

// stacks is every slot of one page: filler, buttons, and the arrows that apply.
func (m *Menu) stacks(who string, page int) []item.Stack {
	size := m.container.Size()
	stacks := make([]item.Stack, size)
	if m.Filler != "" {
		filler := newStack(m.Filler, 0, 1).WithCustomName(*m.FillerName)
		for i := range stacks {
			stacks[i] = filler
		}
	}
	for _, b := range m.Pages[page].Items {
		st := newStack(b.Item, b.Meta, b.Count)
		if b.Name != "" {
			st = st.WithCustomName(m.fill(b.Name, who, page))
		}
		if len(b.Lore) > 0 {
			st = st.WithLore(m.fillAll(b.Lore, who, page)...)
		}
		stacks[*b.Slot] = st.WithValue(buttonKey, ref(m.name, page, "item", *b.Slot))
	}
	if page > 0 {
		stacks[*m.Previous.Slot] = m.arrow(m.Previous, who, page, "prev")
	}
	if page < len(m.Pages)-1 {
		stacks[*m.Next.Slot] = m.arrow(m.Next, who, page, "next")
	}
	return stacks
}

func (m *Menu) arrow(a Arrow, who string, page int, kind string) item.Stack {
	st := newStack(a.Item, 0, 1).WithCustomName(m.fill(a.Name, who, page))
	if len(a.Lore) > 0 {
		st = st.WithLore(m.fillAll(a.Lore, who, page)...)
	}
	return st.WithValue(buttonKey, ref(m.name, page, kind, *a.Slot))
}

func newStack(name string, meta int16, count int) item.Stack {
	it, _ := world.ItemByName(name, meta) // validated in Load
	return item.NewStack(it, count)
}

// fill replaces {player}, {page} and {pages}.
func (m *Menu) fill(s, who string, page int) string {
	return strings.NewReplacer(
		"{player}", who,
		"{page}", strconv.Itoa(page+1),
		"{pages}", strconv.Itoa(len(m.Pages)),
	).Replace(s)
}

func (m *Menu) fillAll(lines []string, who string, page int) []string {
	out := make([]string, len(lines))
	for i, l := range lines {
		out[i] = m.fill(l, who, page)
	}
	return out
}

// --- clicks --------------------------------------------------------------------------------

func ref(menu string, page int, kind string, slot int) string {
	return fmt.Sprintf("%s|%d|%s|%d", menu, page, kind, slot)
}

func parseRef(s string) (menu string, page int, kind string, slot int, ok bool) {
	parts := strings.Split(s, "|")
	if len(parts) != 4 {
		return "", 0, "", 0, false
	}
	page, err1 := strconv.Atoi(parts[1])
	slot, err2 := strconv.Atoi(parts[3])
	return parts[0], page, parts[2], slot, err1 == nil && err2 == nil
}

type router struct{}

// Submit is called by inv for every click; inv has already cancelled the take.
func (router) Submit(p *player.Player, it item.Stack) {
	v, ok := it.Value(buttonKey)
	if !ok {
		return // filler
	}
	raw, _ := v.(string)
	name, page, kind, slot, ok := parseRef(raw)
	c := current.Load()
	if !ok || c == nil || c.Menus[name] == nil {
		return
	}
	m := c.Menus[name]
	if page >= len(m.Pages) {
		return // the file was reloaded with fewer pages while this chest was open
	}

	switch kind {
	case "prev", "next":
		to := page + 1
		if kind == "prev" {
			to = page - 1
		}
		if to < 0 || to >= len(m.Pages) {
			return
		}
		next := m.build(p.Name(), to)
		if m.fill(m.Title, p.Name(), to) != m.fill(m.Title, p.Name(), page) {
			inv.SendMenu(p, next) // the title changes (e.g. "{page}"), which needs a fresh chest
		} else {
			inv.UpdateMenu(p, next) // same chest, new contents
		}
	case "item":
		for _, b := range m.Pages[page].Items {
			if *b.Slot == slot {
				runButton(p, m, page, b)
				return
			}
		}
	}
}

func (router) Close(*player.Player) {}

func runButton(p *player.Player, m *Menu, page int, b Button) {
	if b.Close && b.Open == "" {
		inv.CloseContainer(p)
	}
	if b.Message != "" {
		p.Message(m.fill(b.Message, p.Name(), page))
	}
	if b.Command != "" {
		line := m.fill(b.Command, p.Name(), page)
		if !strings.HasPrefix(line, "/") {
			line = "/" + line
		}
		p.ExecuteCommand(line)
	}
	if b.Open != "" {
		if err := Open(p, b.Open); err != nil {
			p.Message("§cYou can't open that menu.")
		}
	}
}
