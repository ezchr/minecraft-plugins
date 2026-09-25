// Command example is a minimal Dragonfly server with chest menus - the three setup steps the
// plugin needs, and nothing else.
//
//	cp ../menus.example.toml menus.toml
//	go run .
package main

import (
	"flag"
	"log/slog"
	"os"

	"github.com/bedrock-gophers/intercept/intercept"
	"github.com/bedrock-gophers/inv/inv"
	"github.com/df-mc/dragonfly/server"
	"github.com/df-mc/dragonfly/server/player"

	chestmenu "github.com/ezchr/minecraft-plugins/dragonfly/chest-menu"
)

func main() {
	menuFile := flag.String("menus", "menus.toml", "path to the menu file")
	flag.Parse()
	log := slog.Default()

	conf, err := server.DefaultConfig().Config(log)
	if err != nil {
		log.Error("server config", "err", err)
		os.Exit(1)
	}

	// 1. inv fakes chests by rewriting the packet stream, so every listener goes through intercept.
	conf.Listeners = intercept.WrapListeners(conf.Listeners)
	srv := conf.New()
	intercept.Start(srv)
	srv.CloseOnProgramEnd()

	// 2. Load the menus - every problem in the file is reported here - and add their commands.
	menus, err := chestmenu.Load(*menuFile)
	if err != nil {
		log.Error("menus", "err", err)
		os.Exit(1)
	}
	chestmenu.Register(menus, chestmenu.Options{})

	srv.Listen()
	for p := range srv.Accept() {
		// 3. Close a player's open menu when they leave, or inv keeps its state for them.
		p.Handle(quitHandler{})
	}
}

type quitHandler struct{ player.NopHandler }

func (quitHandler) HandleQuit(p *player.Player) { inv.CloseContainer(p) }
