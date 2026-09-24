# Deploying CMA-Flow to Render

This walks through taking the app from your computer (`D:\CMAFlow-Balala`) to
a live URL on the internet, using Render's Blueprint feature
(`render.yaml`, already in this folder) to provision the web service and
database together in one step.

Two things only you can do, because they involve your own accounts and
credentials: creating the GitHub repo and authorizing Render to read it.
Everything else in `render.yaml` is already configured.

## What's already done

- `db/pool.js` — now understands Render's `DATABASE_URL` connection string
  (used automatically in production) as well as your local `.env` (used
  automatically for local development). Nothing to change either way.
- `server.js` — added a `/healthz` endpoint Render uses to confirm the app
  is alive.
- `render.yaml` — defines the whole deployment: a Node web service on the
  Standard plan (1 CPU / 2GB RAM — the ML engine needs the headroom, see
  below), a managed Postgres database, and a 1GB persistent disk for the
  uploaded-dataset archive. They're wired together automatically; you
  won't need to copy any connection strings by hand.
- `package.json` — removed `playwright` and `mermaid`, both unused by the
  running app (confirmed by searching every route/service/script for a
  `require` of either) and both expensive to install on a build server —
  `playwright` in particular tries to download a Chromium browser on
  install unless told not to, which is dead weight here.
- `.gitignore` — excludes `node_modules/`, `.env`, `uploads/`, and (in
  this folder specifically) `docs/`, `sample-data/`, `Claude outputs/`,
  and the stray nested `cma-flow-app/` folder — none of those are app
  source, so they stay off GitHub.

## Why the Standard plan, not Free

I ran the app and watched its memory live: the Round 22 Semantic Field
Detection Engine loads a 341,000-word pretrained embeddings file at
startup, and the process settles around **1GB of RAM before handling a
single request**. Render's Free and Starter plans both cap out at 512MB —
the app would be killed for using too much memory before it even
finished booting. The Standard plan (1 CPU / 2GB RAM, render.yaml is
already set to it) is the minimum that reliably works as-is.

## Step 1 — Push this code to GitHub

Open a terminal (PowerShell or Git Bash) in `D:\CMAFlow-Balala` and run:

```
git init
git branch -M main
git add -A
git status
```

Check the `git status` output: you should see `server.js`, `package.json`,
`render.yaml`, `routes/`, `services/`, `views/`, `db/`, `middleware/`,
`public/`, `ml-data/`, `ml-models/`, `scripts/`, `README.md`, and
`.env.example` staged — and nothing from `node_modules/`, `uploads/`,
`.env`, `docs/`, `sample-data/`, or `Claude outputs/`. If something
unexpected shows up, stop and check `.gitignore` before committing.

```
git commit -m "Prepare CMA-Flow for deployment on Render"
```

Then on github.com: click **New repository**, name it (e.g.
`cma-flow-app`), leave it empty (no README/.gitignore/license — you
already have those locally), and choose Public or Private — either works
with Render, so Private is fine if you'd rather keep the dissertation
code out of public view. After it's created, GitHub shows you the push
commands; they'll look like:

```
git remote add origin https://github.com/<your-username>/cma-flow-app.git
git push -u origin main
```

Run those two lines. GitHub will prompt you to sign in (a browser
window, or a personal access token if you've set that up before) — that
part is between you and GitHub, nothing here touches your credentials.

## Step 2 — Create the Render Blueprint

1. Go to [render.com](https://render.com) and sign up or log in.
2. Connect your GitHub account when prompted (Render asks which repos it
   can see — you can grant just the one repo).
3. Click **New > Blueprint**, and pick the `cma-flow-app` repo.
4. Render reads `render.yaml` from the repo and shows you exactly what
   it's about to create: the `cma-flow` web service (Standard plan) and
   the `cma-flow-db` Postgres database, plus the `cma-flow-uploads` disk.
   **This screen shows the actual current price** for each piece before
   you commit to anything — worth a look, since Render's prices can
   change and I don't want to quote you a number that's gone stale by
   the time you read this.
5. Click **Apply**. Render will: create the database, build the web
   service (`npm install`), run the schema against the fresh database
   (`npm run db:init` — safe to run every time, it only creates tables
   that don't already exist), then start the app (`npm start`).
6. First boot takes a few minutes for the build, then another ~30
   seconds for the app itself once it's running (that's the embeddings
   file loading — the same delay I measured locally). Render's dashboard
   shows live logs the whole time, so you can watch it come up.
7. Once it says **Live**, open the URL Render assigns (something like
   `https://cma-flow.onrender.com` — you can rename the service, and
   later attach a custom domain if you want, under the service's
   Settings tab). Sign up a test account and click through a few
   analytics pages to confirm everything works end to end.

From here on, every `git push` to `main` automatically redeploys — no
need to touch the Render dashboard again for routine updates.

## A few things worth knowing

- **Session secret and database credentials are handled for you.**
  `render.yaml` has Render generate a random session secret and wire the
  database's connection string into the web service automatically —
  there's nothing to copy or paste.
- **The persistent disk means deploys aren't zero-downtime** — the
  service restarts briefly on each deploy instead of rolling over
  seamlessly. For a single-instance research/demo deployment that's a
  non-issue; it only matters if you ever needed multiple instances
  running simultaneously (which the disk itself also rules out).
- **The raw CSV archive is a convenience, not a dependency.** I checked:
  nothing in the app reads `uploads/datasets/` back after a file is
  parsed into Postgres — every analytics screen reads from the database.
  The disk just means those original files stick around after a restart
  instead of disappearing; if you ever wanted to drop the disk to save
  the small monthly cost, nothing would break.
- **One pre-existing, low-priority item**: `npm audit` flags a moderate
  vulnerability in a transitive dependency of `exceljs` (its `uuid`
  package). The only available fix downgrades `exceljs` itself, which is
  a breaking change I didn't want to make silently — worth a look before
  your next release, not something blocking this deployment.
