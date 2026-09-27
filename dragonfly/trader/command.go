package trader

import (
	"fmt"
	"strings"

	"github.com/df-mc/dragonfly/server/cmd"
	"github.com/df-mc/dragonfly/server/player"
	"github.com/df-mc/dragonfly/server/world"
)

// /trader - places and manages villager traders whose offers live in
// traders.json. Register it with Command.
//
//	/trader create <id>   places trader <id> where you stand, facing you
//	/trader remove        removes the nearest trader within 6 blocks
//	/trader remove <trader>  removes a placed trader from any distance
//	/trader list          lists the traders defined in traders.json
//	/trader reload        re-reads traders.json (no restart needed)

// TraderID is a cmd.Enum over the trader ids in traders.json.
type TraderID string

func (TraderID) Type() string                { return "TraderID" }
func (TraderID) Options(cmd.Source) []string { return IDs() }

type TraderCreateCommand struct {
	Create cmd.SubCommand `cmd:"create"`
	ID     TraderID       `cmd:"id"`
}

type TraderRemoveCommand struct {
	Remove cmd.SubCommand `cmd:"remove"`
}

// PlacedTrader is a cmd.Enum over the placed traders, e.g. "example_1".
type PlacedTrader string

func (PlacedTrader) Type() string                { return "PlacedTrader" }
func (PlacedTrader) Options(cmd.Source) []string { return PlacedLabels() }

type TraderRemovePlacedCommand struct {
	Remove cmd.SubCommand `cmd:"remove"`
	Which  PlacedTrader   `cmd:"trader"`
}

// TraderRemoveNamedCommand takes the trader as free text. The client refuses
// to send a command whose enum value is not in its own copy of the list, so
// this keeps /trader remove <name> working even when that copy is stale.
type TraderRemoveNamedCommand struct {
	Remove cmd.SubCommand `cmd:"remove"`
	Name   string         `cmd:"name"`
}

type TraderListCommand struct {
	List cmd.SubCommand `cmd:"list"`
}

type TraderReloadCommand struct {
	Reload cmd.SubCommand `cmd:"reload"`
}

func (c TraderCreateCommand) Run(source cmd.Source, o *cmd.Output, tx *world.Tx) {
	if !allowed(source, o) {
		return
	}
	p := source.(*player.Player)
	// Face the trader back toward the player who placed it.
	yaw := p.Rotation().Yaw() + 180
	if err := Spawn(tx, string(c.ID), p.Position(), yaw); err != nil {
		o.Error(err.Error())
		return
	}
	o.Printf("§aPlaced trader %s. §7Step aside and right-click it to trade.", c.ID)
}

func (TraderRemoveCommand) Run(source cmd.Source, o *cmd.Output, tx *world.Tx) {
	if !allowed(source, o) {
		return
	}
	p := source.(*player.Player)
	id, ok := RemoveNearest(tx, p.Position(), 6)
	if !ok {
		o.Error("No trader within 6 blocks.")
		return
	}
	o.Printf("§aRemoved trader %s.", id)
}

func (c TraderRemovePlacedCommand) Run(source cmd.Source, o *cmd.Output, tx *world.Tx) {
	removePlacedTrader(source, o, tx, string(c.Which))
}

func (c TraderRemoveNamedCommand) Run(source cmd.Source, o *cmd.Output, tx *world.Tx) {
	removePlacedTrader(source, o, tx, c.Name)
}

func removePlacedTrader(source cmd.Source, o *cmd.Output, tx *world.Tx, label string) {
	if !allowed(source, o) {
		return
	}
	p, _ := source.(*player.Player)
	var handle *world.EntityHandle
	if p != nil {
		handle = p.H()
	}
	err := RemovePlaced(tx, label, func(tx *world.Tx, r RemoveResult) {
		msg := fmt.Sprintf("§aRemoved trader %s at %.0f, %.0f, %.0f.", label, r.Pos[0], r.Pos[1], r.Pos[2])
		if r.Gone {
			msg = fmt.Sprintf("§eTrader %s was no longer at %.0f, %.0f, %.0f; removed it from the list.", label, r.Pos[0], r.Pos[1], r.Pos[2])
		}
		if handle == nil {
			o.Print(msg)
			return
		}
		// done may run a tick later, when the command output is already sent.
		if e, ok := handle.Entity(tx); ok {
			e.(*player.Player).Message(msg)
		}
	})
	if err != nil {
		o.Error(err.Error())
	}
}

func (TraderListCommand) Run(source cmd.Source, o *cmd.Output, _ *world.Tx) {
	if !allowed(source, o) {
		return
	}
	ids := IDs()
	if len(ids) == 0 {
		o.Print("No traders defined in traders.json.")
		return
	}
	byID := PlacedByID()
	var lines []string
	for _, id := range ids {
		lines = append(lines, Describe(id))
		if len(byID[id]) == 0 {
			lines = append(lines, "  §8not placed anywhere")
		}
		for _, l := range byID[id] {
			lines = append(lines, "  §7- §f"+l)
		}
		delete(byID, id)
	}
	// Placed traders whose id was removed from traders.json.
	for id, ls := range byID {
		lines = append(lines, id+" §c(not in traders.json)")
		for _, l := range ls {
			lines = append(lines, "  §7- §f"+l)
		}
	}
	o.Print(strings.Join(lines, "\n"))
}

func (TraderReloadCommand) Run(source cmd.Source, o *cmd.Output, tx *world.Tx) {
	if !allowed(source, o) {
		return
	}
	n, problems := Load(nil)
	renamed := RefreshNames(tx, source.(*player.Player).Position(), 128)
	o.Printf("§aReloaded %d trader(s); updated %d name tag(s) nearby.", n, renamed)
	for _, p := range problems {
		o.Printf("§e%s", p)
	}
}

var allowFunc = func(cmd.Source) bool { return false }

// Command returns the /trader command. allow decides who may use it - pass
// your server's admin check. Every subcommand is refused for anyone else.
func Command(allow func(src cmd.Source) bool) cmd.Command {
	allowFunc = allow
	return cmd.New("trader", "Places, removes, lists and reloads villager traders (traders.json)", nil,
		TraderCreateCommand{}, TraderRemovePlacedCommand{}, TraderRemoveNamedCommand{}, TraderRemoveCommand{},
		TraderListCommand{}, TraderReloadCommand{})
}

// allowed reports whether source may use /trader, telling it off if not.
func allowed(source cmd.Source, o *cmd.Output) bool {
	if allowFunc(source) {
		return true
	}
	o.Error("You do not have permission to use /trader.")
	return false
}
