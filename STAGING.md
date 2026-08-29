# Staging workflow

One-time setup, done once. Steps 6-7 are the actual day-to-day loop from
here on.

## 1. Staging Supabase project

Create a second Supabase project (e.g. `tavzio-staging`). Open its SQL
editor and run every file in `supabase/migrations/` in order, oldest
first - this brings its schema up to date with production. Track this in
`MIGRATIONS_CHECKLIST.md` in this repo.

## 2. `staging` branch

```
git checkout -b staging
git push -u origin staging
```
Do this once, in this original folder. `main` (production) is untouched.

## 3. Second local folder via git worktree

```
git worktree add ../tavzio-backend-supabase-staging staging
```
Do the equivalent in the frontend repo too. This gives you a real,
separate folder on disk, checked out to `staging`, still the same
underlying repo - open it in VS Code for day-to-day work instead of this
one.

## 4. `.env` in the staging folder

Copy `.env.staging.example` (in this repo) to `.env` inside
`tavzio-backend-supabase-staging/`, and fill in real staging values -
staging Supabase project, Ziina *sandbox* key, etc. See that file's own
comments for which values are safe to reuse from production and which
must be staging-only. Do the same for the frontend using its own
`.env.staging.example`.

From this point on, running the app locally from the `-staging` folder
always hits staging infrastructure, regardless of git branch - this file
is gitignored and never changes on its own.

## 5. Vercel + Railway staging environments

**Vercel:** Project → Settings → Domains → add a staging domain (e.g.
`staging.tavzio.ae`) and assign it to the `staging` branch specifically.

**Railway:** Project → Settings → Environments → New Environment, name it
`staging`, set its env vars to the staging values from step 4, and set
its deploy branch to `staging`.

## 6. Day-to-day work (the actual loop)

Everything happens in the `-staging` folders:
```
cd tavzio-backend-supabase-staging
# make changes
git add .
git commit -m "..."
git push
```
Vercel/Railway auto-deploy staging. Test on your staging domain against
the staging database - nothing here can touch a real customer.

If the change includes a new migration file: run it against the
*staging* Supabase project first, check it off in
`MIGRATIONS_CHECKLIST.md`, and only mark the production column once
you've actually run it there too (step 7).

## 7. Promoting to production

Once confirmed working on staging:
```
cd tavzio-backend-supabase        # the ORIGINAL folder, on main
git pull origin main
git merge staging
git push
```
Same in the frontend repo. Vercel/Railway deploy `main` automatically.
Run any new migration files against the *production* Supabase project
now, and check the production column in `MIGRATIONS_CHECKLIST.md`.

Never copy files directly into this folder by hand - always let `git
pull`/`git merge` do it, so history stays accurate and any change is
reviewable and revertible.
