# Flow

Flow is a macOS app where an agent workspace is a place, not a tab strip. Terminals, real web pages and notes sit on one freeform board, and a board is a workspace. Sub-workspaces hang off it, so a project with five threads is five boards under one parent instead of five tabs and a scrollback you lost.

Every window carries its own note, page state and files. A page opened beside another page inherits its notes and annotations, so what belongs to the page follows the page.

Electron 45, plain JS, no bundler, no database.

## Running it

```
npm start
```

Isolated dev run, so it does not touch the real profile:

```
FLOW_USER_DATA=/tmp/flow-dev FLOW_TMUX_SOCKET=flow-dev FLOW_CDP_PORT=9561 npm start
```

## Tests

