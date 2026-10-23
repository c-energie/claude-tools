# claude-tools

The c-energie plugin marketplace: the org's Claude Code tooling, one plugin per concern.

## Language

### Project workspace

**Nested analysis**:
An analysis repo that lives inside one document repo and feeds only that document.
_Avoid_: Embedded analysis, document analysis

**Workspace analysis**:
An analysis repo that is a member of the workspace in its own right, not inside any document repo, and feeds zero or more documents.
_Avoid_: Standalone analysis, root analysis, shared analysis

### Setup skills

**Setup skill**:
A skill that walks a user through a one-time setup, with the judgement in its SKILL.md and the mechanics in a step script beside it.
_Avoid_: Onboarding skill, installer

**Repo-local setup skill**:
A setup skill that lives in the repo it sets up, under that repo's `.claude/skills/`.
_Avoid_: Project skill

**Plugin-shipped setup skill**:
A setup skill that ships in a marketplace plugin and sets up whichever project it is invoked in.
_Avoid_: Plugin skill (too broad)

**Owned state**:
A state file a setup skill creates and whose schema it defines; later skills read it instead of asking again.
_Avoid_: Config file, settings

**Joined state**:
A state record that already existed before the setup skill and that other skills defined; the setup skill only fills it in.
_Avoid_: Shared state, existing state
