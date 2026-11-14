# Frontend Engineering Framework

A general standard for planning, building, and maintaining a frontend. It is not a product design and it does not require a particular library.

Use it in proportion to the product. A small internal page does not need every practice below. A customer-facing application does. Do not adopt a tool because another project used it. Adopt it when the requirements justify the cost.

Eight principles apply to every domain: maintainability, scalability, reusability, simplicity, consistency, reliability, security, and testability. They are how to choose, not a separate checklist of features.

## 1. Framework and technology stack

Choose languages, UI frameworks, libraries, build tools, and local tooling from the product's requirements, the existing infrastructure, compatibility, maintainability, and how long the choice will be supported.

Keep the client and the system of record as separate deployable parts unless there is a concrete reason to combine them. Do not introduce a second server, a second language, or a large framework without saying what problem it solves.

## 2. Component architecture and design system

Define what each component is responsible for, and what it must not do.

- Prefer a small set of reusable components over one-off markup.
- Compose screens from those components.
- Keep styling tokens (color, type, space, focus) in one place so screens stay consistent.
- A component renders and reports user intent. It does not own business rules that belong on the server.

## 3. State management and data fetching

Separate three kinds of state.

- Local state: input the user has not submitted.
- Global UI state: rare, and only when many screens truly share it.
- Server state: anything the server already stores. Fetch it, cache it, and treat the server copy as the source of truth.

Define loading, refresh, and stale behavior explicitly. Use optimistic updates only when a failed request can be rolled back without lying to the user.

## 4. Routing and navigation

Organize routes around the tasks a person performs. Use nested layouts for chrome that does not change. Protect routes that require a session. Support deep links to a specific record. Use the same navigation on every signed-in screen.

## 5. Forms, validation, and user interactions

Give forms a clear structure: fields, client checks for obvious mistakes, and server checks that are the ones that count. Show errors next to the field or the action that failed. Show waiting, success, and failure. Ask for confirmation before a destructive action.

## 6. Accessibility and responsive design

Use semantic HTML. Everything operable by mouse must be operable by keyboard. Preserve focus order. Meet contrast. Do not rely on color alone. Layouts must work on a laptop and on a tablet, including touch targets large enough to hit. Data-heavy regions may scroll; they may not become unreadable.

## 7. Frontend testing

Test behavior, not snapshots of markup, unless a visual regression suite is an explicit choice.

- Unit tests for pure logic.
- Component tests for states a person sees: empty, loading, error, success, and validation.
- Integration tests for a feature's main path.
- End-to-end tests for a few critical journeys, after the API exists.
- Accessibility checks on those journeys.

Do not add visual regression by default.

## 8. Frontend architecture and code organization

Organize by feature. Keep shared UI separate from feature screens. API calls live in one client per feature, not inside presentational components. The client does not reimplement server rules. Dependencies point inward: screens use components and clients; components do not import screens.

## 9. Performance and optimization

Measure before optimizing. Split code by route. Do not render unbounded lists when a page of results will do. Cache server data instead of refetching on every small interaction. Optimize images and other assets when they are large enough to matter. Watch bundle size when adding a dependency.

## 10. Security

The browser is not a trusted place for secrets. Do not put privileged credentials in source, in `localStorage`, or in a bundle. Prefer a session the browser cannot read (an httpOnly cookie) over a token JavaScript can copy. Send requests only to the application's own API. Encode untrusted text as text. Depend on the server for authorization; hiding a button is not access control.

## 11. Error handling and observability

Every data screen has a loading state, an empty state, an error state, and a success state. An error in one record is not an error for the whole page. User-facing messages are generic. Detailed failures go to logs, with enough context to diagnose them, and without secrets. Provide a recovery action: retry, go back, or sign in again.
