# Demo GIF for the README — render with VHS (https://github.com/charmbracelet/vhs):
#
#   vhs docs/demo.tape                                   # from the repo root
#   RELAY_BIN=/path/to/relay.mjs vhs docs/demo.tape      # use a specific CLI bundle
#
# Needs a running relaywise gateway on http://127.0.0.1:8420 (docker compose up -d).
# The real task costs well under a cent (Jev routes it to a cheap model).

Output docs/demo.gif

Set Shell zsh
Set FontSize 16
Set Width 1200
Set Height 780
Set Padding 20
Set Theme "Catppuccin Mocha"
Set TypingSpeed 35ms
Set Framerate 20
Set CursorBlink false

# --- hidden setup: a tiny throwaway git repo and a `relay` alias ------------------
Hide
Type `alias relay="node ${RELAY_BIN:-$PWD/apps/cli/dist/relay.mjs} --project shop-$(openssl rand -hex 4)"`
Enter
Type `export PS1='%F{8}~/shop%f %F{6}❯%f ' && rm -rf /private/tmp/shop && mkdir -p /private/tmp/shop && cd /private/tmp/shop && git init -q && printf 'def total(items):\n    return sum(i["price"] * i["qty"] for i in items)\n' > cart.py && git add . && git commit -qm init && clear`
Enter
Sleep 1s
# Start relay before the recording shows, so the first frame is the welcome panel.
Type "relay"
Enter
Wait+Screen@20s /Ask for a change/
Show
Sleep 2s

# --- ask Jev where a task would go (free: nothing runs) ----------------------------
Type "/route add a discount function to cart.py with input validation"
Sleep 500ms
Enter
Sleep 5s

# --- a real task ------------------------------------------------------------------------
Type "Add apply_discount(items, pct) to cart.py; reject pct outside 0-100"
Sleep 500ms
Enter
Wait+Screen@180s /done ·/
Sleep 3s

# --- the change, applied to your working tree ------------------------------------
Type "/diff"
Sleep 400ms
Enter
Sleep 6s

Ctrl+C
Sleep 200ms
Ctrl+C
Sleep 1500ms
