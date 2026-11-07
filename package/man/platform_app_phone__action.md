#### Description

Execute an authenticated Phone action. The action receives the platform principal from aux4/api; callers cannot supply a replacement identity.

#### Usage

```bash
aux4 platform app phone action <action>
```

Actions are `start`, `accept`, `decline`, `leave`, `heartbeat`, and `signal`.
