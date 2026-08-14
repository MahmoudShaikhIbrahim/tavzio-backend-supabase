-- =========================================================================
-- Real department routing for custom notification buttons, plus
-- group/folder buttons on the landing page.
-- =========================================================================
-- Confirmed design: Housekeeping and Maintenance requests don't belong
-- in the generic Requests feed at all - they route straight into the
-- real, already-built housekeeping_tasks / maintenance_tickets tables,
-- so they show up on the actual Housekeeping screen with real status
-- tracking, not just a ping in a shared list a Front Desk agent has to
-- scroll past. Everything else (Front Desk, Orders, any other section)
-- uses the existing Requests list, but filtered by section - a staff
-- member only sees a request if it's tagged for a section they're
-- actually assigned to, reusing the exact same assigned_sections
-- mechanism that already governs their dashboard tabs.

alter table public.custom_buttons drop constraint if exists custom_buttons_button_type_check;
alter table public.custom_buttons add constraint custom_buttons_button_type_check
  check (button_type in ('link', 'notification', 'group'));

-- Only meaningful for button_type = 'notification'. Which real system
-- receives the request when this button is pressed.
alter table public.custom_buttons add column if not exists notification_destination text not null default 'general'
  check (notification_destination in ('general', 'housekeeping_task', 'maintenance_ticket'));

-- Only meaningful when notification_destination = 'general' - which
-- dashboard section (see SECTION_OPTIONS) should see this request in
-- their Requests list. NULL = visible to everyone with Requests access,
-- same as today's behavior - this is why every existing Call
-- Waiter/Request Bill button migrated in 0056 keeps working unchanged,
-- nothing routes anywhere different until an owner explicitly picks a
-- section for it.
alter table public.custom_buttons add column if not exists target_section text;

-- A 'group' button (e.g. "Services") shows a list of its own children
-- instead of doing anything itself when tapped. A button with
-- parent_button_id set only ever appears inside its parent's expanded
-- list, never directly on the landing page - this is what makes
-- multiple independent groups, and a mix of standalone + grouped
-- buttons, all possible at once.
alter table public.custom_buttons add column if not exists parent_button_id uuid references public.custom_buttons(id) on delete cascade;
create index if not exists idx_custom_buttons_parent on public.custom_buttons(parent_button_id) where parent_button_id is not null;

-- Same section-filtering field, mirrored onto orders - this is what
-- listRequests actually filters on for 'general'-destination requests.
alter table public.orders add column if not exists target_section text;
