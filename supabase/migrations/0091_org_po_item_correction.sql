-- =========================================================================
-- Real correction, found while building the org-level purchase order
-- controllers: purchase_order_items.ingredient_id is a required FK to
-- an ingredient, which is business-scoped. That's fine for a normal
-- business-level PO (always exactly one business's own ingredient) but
-- breaks for an org-level PO, which has no single business's ingredient
-- to point to - "200kg flour" ordered at the org level isn't any one
-- business's "Flour" ingredient row until it's actually allocated to
-- one.
--
-- Fix: ingredient_id becomes optional. An org-level item instead
-- carries its own free-text name/unit (still human-readable without a
-- canonical ingredient row), and the actual mapping to a specific
-- business's own ingredient happens at the allocation level - each
-- business's allocation says which of ITS OWN ingredients this
-- delivery restocks, exactly at the point where that business
-- receives its share, never before.
-- =========================================================================

alter table public.purchase_order_items alter column ingredient_id drop not null;
alter table public.purchase_order_items add column if not exists item_name text default '';
alter table public.purchase_order_items add column if not exists item_unit text default '';

alter table public.purchase_order_items drop constraint if exists purchase_order_items_identity_check;
alter table public.purchase_order_items add constraint purchase_order_items_identity_check check (
  ingredient_id is not null or item_name <> ''
);

comment on column public.purchase_order_items.ingredient_id is 'Required for a business-level PO (that business''s own ingredient). NULL for an org-level PO, where item_name/item_unit describe the item instead - it has no single canonical ingredient until allocated.';

alter table public.purchase_order_allocations add column if not exists ingredient_id uuid references public.ingredients(id) on delete set null;

comment on column public.purchase_order_allocations.ingredient_id is 'Which of the RECEIVING business''s own ingredients this allocation restocks - set by the org_owner at allocation time if known, or by the business itself when it actually receives its share.';
