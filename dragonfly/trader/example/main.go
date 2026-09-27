// Command example is a minimal Dragonfly server with villager traders - the
// setup steps the plugin needs, and nothing else. It writes an example
// traders.json on first run.
//
//	go run .
package main

import (
	"log/slog"
	"os"

	"github.com/df-mc/dragonfly/server"
	"github.com/df-mc/dragonfly/server/cmd"
	"github.com/df-mc/dragonfly/server/entity"
	"github.com/df-mc/dragonfly/server/player"
	"github.com/df-mc/dragonfly/server/world"

	"github.com/ezchr/minecraft-plugins/dragonfly/trader"
)

func main() {
	log := slog.Default()

	conf, err := server.DefaultConfig().Config(log)
	if err != nil {
		log.Error("server config", "err", err)
		os.Exit(1)
	}

	// 1. Register the trader entity type so placed traders are saved with the world.
	conf.Entities = entity.DefaultRegistry.Config().New(append(entity.DefaultRegistry.Types(), trader.Type))
	srv := conf.New()
	srv.CloseOnProgramEnd()

	// 2. Load traders.json and add /trader. Swap the allow function for your own admin check:
	// this one lets every player use it.
	if _, problems := trader.Load(log); len(problems) > 0 {
		log.Warn("traders.json has problems - see the lines above")
	}
	cmd.Register(trader.Command(func(src cmd.Source) bool {
		_, isPlayer := src.(*player.Player)
		return isPlayer
	}))

	srv.Listen()
	for p := range srv.Accept() {
		// 3. Open the trading window when a player right-clicks a trader.
		p.Handle(traderHandler{})
	}
}

type traderHandler struct{ player.NopHandler }

func (traderHandler) HandleItemUseOnEntity(ctx *player.Context, e world.Entity) {
	if trader.Interact(ctx.Player(), e) {
		ctx.Cancel()
	}
}
