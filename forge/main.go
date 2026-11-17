// Binary entrypoint: binds an ephemeral loopback port, prints it on
// stdout as the first line ("PORT <n>"), then serves the forge.
// main.ts (Node) spawns this binary and reads the port from stdout.
// All other logging goes to stderr so stdout stays parseable.
package main

import (
	"fmt"
	"log"
	"net"
	"net/http"
	"os"
	"runtime"
)

func main() {
	log.SetOutput(os.Stderr)
	// The pod gives the forge 2 CPUs; this VM's quota is 1.5 shared CPUs
	// while the host exposes 4. Pin GOMAXPROCS to 2 so the Go scheduler
	// does not run more threads than the cgroup can actually schedule.
	runtime.GOMAXPROCS(2)
	token := os.Getenv("MAKEFUN_SHOP_TOKEN")
	if token == "" {
		log.Fatal("MAKEFUN_SHOP_TOKEN must be set")
	}
	state := newForgeState(token)
	server := &forgeServer{state: state}

	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		log.Fatalf("listen: %v", err)
	}
	port := ln.Addr().(*net.TCPAddr).Port
	fmt.Printf("PORT %d\n", port)
	_ = os.Stdout.Sync()
	httpServer := &http.Server{Handler: server}
	if err := httpServer.Serve(ln); err != nil {
		log.Fatalf("serve: %v", err)
	}
}
