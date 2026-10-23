# A node port of the setup observer

The step-0 setup observer (`setup-observer`: `SKILL.md` + `observe.py`) has one master, in the
`skills` plugin's assets, and it is Python run through `uv`. There will not be a node port.

## Why this is out of scope

The observer is copied verbatim into every plugin and repo that ships a setup skill, and
check-plugin errors when a copy drifts from the master. A node port would mean two masters
that must behave identically: twice the drift surface, and every fix made twice. That is on
the one component whose whole job is to notice when setup guides go wrong.

What a port would buy is small. Node-only topic plugins (diagrams was the first) need `uv` for
step 0 only, and `uv` is a single, well-supported install. The doc-workspace plugins need it
anyway.

The setup skill's *own* step script can be node (`scaffold.mjs` picks the language from the
script's extension, per #44). That choice is independent of the observer.

## When to reconsider

If users of a node-only plugin actually get stuck because `uv` is missing, the observer will
file that as a deviation. A real report like that is the reason to revisit, not the principle.

## Prior requests

- #44, item 5: "a node port of `observe.py` at some point"
