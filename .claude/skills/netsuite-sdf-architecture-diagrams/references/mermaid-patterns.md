# Mermaid patterns for NetSuite SDF architecture diagrams

Copy-ready templates for the six standard diagrams. Replace the placeholder labels
with the real scriptids/record types you found in `src/Objects/*.xml` and the
`@NScriptType` tags in the SuiteScript files. Keep the `classDef` block identical
across diagrams so a Suitelet always looks like a Suitelet.

## Shared class definitions

Paste this `classDef` set into any `graph`/`flowchart` diagram for a consistent palette.
Colors are brand-neutral; swap the Suitelet accent for the org brand color if desired
(Myers-Holum / company blue: `#2976F3`).

```mermaid
graph LR
  ex[External / Actor]:::ext
  sl[Suitelet page]:::suitelet
  ue[User Event]:::ue
  cs[Client Script]:::cs
  ss[Scheduled / MapReduce]:::sched
  lib[Library module]:::lib
  rec[(Custom record)]:::rec

  classDef ext fill:#eceff1,stroke:#607d8b,color:#263238;
  classDef suitelet fill:#e3f0ff,stroke:#2976F3,color:#0d3c78;
  classDef ue fill:#ede7f6,stroke:#5e35b1,color:#311b92;
  classDef cs fill:#fff8e1,stroke:#f9a825,color:#5f4300;
  classDef sched fill:#e0f2f1,stroke:#00897b,color:#004d40;
  classDef lib fill:#f3e5f5,stroke:#8e24aa,color:#4a148c;
  classDef rec fill:#e8f5e9,stroke:#2e7d32,color:#1b5e20;
```

## 1. System context (`graph TB`)

Project as one box; actors and external systems around it.

```mermaid
graph TB
  subgraph project[SDF Project: PROJECT_NAME]
    core[Custom pages + automations]:::suitelet
  end
  role1[Receiving clerk]:::ext --> core
  role2[Controller]:::ext --> core
  core --> native[Native transactions<br/>PO / Item Receipt / SO]:::ext
  core --> docs[PDF / email documents]:::ext
  feed[External price feed]:::ext --> core

  classDef ext fill:#eceff1,stroke:#607d8b,color:#263238;
  classDef suitelet fill:#e3f0ff,stroke:#2976F3,color:#0d3c78;
```

## 2. Script inventory by type

Lead with a table, then a small graph pairing Client Scripts to their pages.

| Script (scriptid) | File | Type | Deployed on | Entry points |
|---|---|---|---|---|
| customscript_x | X.js | SUITELET | n/a | onRequest |
| customscript_y | Y.js | USEREVENTSCRIPT | Item Receipt | beforeLoad, afterSubmit |

```mermaid
graph LR
  slA[SL: PageA]:::suitelet --- csA[CS: PageA client]:::cs
  ueB[UE: RecordB logic]:::ue --- csB[CS: RecordB client]:::cs
  classDef suitelet fill:#e3f0ff,stroke:#2976F3,color:#0d3c78;
  classDef cs fill:#fff8e1,stroke:#f9a825,color:#5f4300;
  classDef ue fill:#ede7f6,stroke:#5e35b1,color:#311b92;
```

## 3. User Event trigger matrix

Table first (authoritative, from deployment XML), then the record→UE graph.

| UE script | Record type | beforeLoad | beforeSubmit | afterSubmit |
|---|---|:--:|:--:|:--:|
| customscript_ue_x | Item Receipt | ✓ |  | ✓ |

```mermaid
graph LR
  ir[Item Receipt]:::rec
  ir --> ue1[UE_LandedCost<br/>beforeSubmit]:::ue
  ir --> ue2[UE_CreateSettlement<br/>afterSubmit]:::ue
  classDef rec fill:#e8f5e9,stroke:#2e7d32,color:#1b5e20;
  classDef ue fill:#ede7f6,stroke:#5e35b1,color:#311b92;
```

## 4. End-to-end data flow (`flowchart LR`)

Annotate each edge with the trigger. Keep side effects on the node label.

```mermaid
flowchart LR
  po[PO created]:::rec -->|scale kiosk<br/>transform| ir[Item Receipt]:::rec
  ir -->|afterSubmit| settle[Settlement Draft]:::rec
  ir -->|afterSubmit| lot[Lot: status Received]:::rec
  settle -->|status = Provisional Paid| bill[Vendor Bill]:::rec
  classDef rec fill:#e8f5e9,stroke:#2e7d32,color:#1b5e20;
```

For time-ordered automation with several actors, a `sequenceDiagram` reads better:

```mermaid
sequenceDiagram
  actor Clerk
  participant Kiosk as Scale Kiosk (SL)
  participant IR as Item Receipt
  participant UE as IR User Events
  Clerk->>Kiosk: weigh-in + submit
  Kiosk->>IR: transform PO -> IR
  IR->>UE: afterSubmit
  UE-->>IR: settlement + lot created
```

## 5. Custom-record ERD (`erDiagram`)

One line of role per entity in the trailing comment or the surrounding prose.

```mermaid
erDiagram
  SETTLEMENT_RECORD ||--o{ PENALTY_DETAIL : "computes"
  SETTLEMENT_SCHEDULE ||--o{ SETTLEMENT_PENALTY : "defines"
  SETTLEMENT_RECORD }o--|| SETTLEMENT_SCHEDULE : "priced by"
  PROCESSING_RECORD ||--o{ PROCESSING_OUTPUT_LINE : "produces"
  PROCESSING_RECORD ||--o{ PROC_INPUT_LINE : "consumes"
```

## 6. Page / screen map (`graph TB`)

Nodes = pages (Suitelets) and decorated native forms. Edges = the button/link that
navigates from one to the next.

```mermaid
graph TB
  ir[Item Receipt view]:::rec -->|Enter Lot Quality btn| lq[SL: Lot Quality]:::suitelet
  ir -->|Process Material btn| pe[SL: Processing Entry]:::suitelet
  ir -->|Create Line Settlements btn| ls[SL: Create Line Settlement]:::suitelet
  classDef rec fill:#e8f5e9,stroke:#2e7d32,color:#1b5e20;
  classDef suitelet fill:#e3f0ff,stroke:#2976F3,color:#0d3c78;
```

## Optional: status state machine (`stateDiagram-v2`)

Use for a status field with guarded transitions and side effects.

```mermaid
stateDiagram-v2
  [*] --> Draft
  Draft --> Completed: approve
  Completed --> ProvisionalPaid: creates provisional bill
  ProvisionalPaid --> FinalSettled: requires Price Fixed flag / creates final bill
  Draft --> Voided
  FinalSettled --> [*]
```

## Parser gotchas (learned the hard way)

- Parentheses inside a node label break the parser. Write `Item Receipt view` not
  `Item Receipt (view)`. Put parenthetical detail in the prose caption instead.
- Avoid raw `%`, `&`, `<`, `>`, and quotes inside labels. Use `<br/>` for wraps.
- `erDiagram` entity names cannot contain spaces — use `SNAKE_CASE` and map them to
  real record-type ids in a table beneath the diagram.
- Keep one `classDef` block per diagram (Mermaid does not share them across fences).
