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
