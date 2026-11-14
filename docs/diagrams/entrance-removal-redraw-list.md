# Diagrams to update after entrance sales removal

Stage 1 checklist. Redrawn 14 November 2026 (context, top level, ERD, use case,
architecture: .drawio and .png); ztims-schema.dbml is unchanged until Stage 2.
In the ERD, Payments (entrance tickets) became Booking Payments under Bookings;
the retired ticket tables still exist in the database but are no longer drawn.

| Existing files | Redraw/change required |
| --- | --- |
| ztims-context-diagram.drawio / .png | Remove entrance purchase, admission validation, entrance receipt/refund and officer collection flows. Keep room booking/payment, attraction information, visitor reporting and feedback. |
| ztims-top-level-diagram.drawio / .png | Remove entrance-sale/check/refund processes and their data flows/stores. Route gateway interactions only through room checkout/payment/refund; preserve statistics source records. |
| ztims-erd.drawio / .png | Distinguish the Stage 1 retained legacy tables from active room payments. Only remove tickets, online_checkouts, payments and reviews.ticket_id after approved Stage 2. Keep booking_checkouts, booking_payments, spot_closed_dates and displayed fees. |
| ztims-use-case.drawio / .png | Remove Buy entrance tickets, Check/admit, entrance refunds and officer Collections. Keep Book/pay for a room, manager payment recording, room refunds, visitor records, Support Staff and reviews of completed stays. |
| ztims-system-architecture.drawio / .png | Keep Vite/Express/Postgres and Xendit. Label Xendit room payments only, via xendit-gateway.js and the unchanged /api/payments/webhook path. |
| ztims-schema.dbml | Stage 1: leave the physical schema as-is. After Stage 2 approval, align retired stores/columns and relationships with the separately committed schema block; informational entrance fees remain. |

Do not change original evaluation evidence or imply the later removal was
included in the original TAM/ISO evaluation. Check manuscript figure numbers
and captions before replacing any manuscript image.
