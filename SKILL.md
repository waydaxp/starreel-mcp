---
name: starreel-drama-production
description: >-
  Operating skill for any AI agent driving the StarReel short-drama production
  pipeline (script → rewrite → extract → portraits + sheets → storyboards → frames →
  video → voiceover → final cut) over MCP or REST. Covers the ordered workflow,
  the eleven operating disciplines (prepaid billing, quote-before-spend, retryable
  failure handling, content compliance, tenancy), and a failure playbook.
license: MIT
homepage: https://api.shortreelai.com/docs/mcp
---

# StarReel Drama Production — Agent Skill

You are an agent driving **StarReel**, a prepaid AI short-drama production
pipeline. You turn a raw script into a finished, downloadable episode by
calling StarReel tools (over MCP) or endpoints (`/v1/produce/*` over REST). This
skill tells you the workflow and the non-negotiable disciplines. Read it before
you spend anything.

Never invent character names, titles, dialogue, or genre from your own
imagination and bake them into calls — the content comes from the user's script.
All examples below use placeholders like `<raw script>` and `<drama title>`.

## What you produce

One episode, the **full** pipeline — nothing skipped:

```
create_drama → set_script(raw) → rewrite_script(AI draft, user may edit)
  → [review_script] → extract_assets(cast/scenes/props)
  → storyboards → [review_storyboards]
  → generate_portraits_and_sheets(portraits + sheets = the shot consistency anchor)
  → frames → [review_frames] → videos → generate_tts(voiceover) → compose_episode → final cut (.mp4 link)
```

The three `[review_*]` steps are free and **enforced** — see discipline 11.
Nothing downstream of them runs until you have reviewed that layer.

`project_type` picks the flavor at `create_drama`: `drama` / `ad` / `mv` /
`brand_film`. MV replaces `rewrite_script` with
`set_mv_lyrics → generate_mv_story → generate_mv_script`, then rejoins the
standard extract → storyboards → … flow. Call `list_project_options` first to
show the user the real project types, aspect ratios, and resolutions.

Free (DB + ffmpeg, no vendor call): `create_drama`, `set_script`, all `get_*`,
edits, `update_project_settings`, `compose_episode`, `render_multi_aspect`,
`generate_sfx` / `generate_effects` / `generate_transitions` (local-library
match), `generate_deliverables`, `add_product` / `list_products`.
Metered (every AI generation): all images, all video, TTS, and all LLM text
(`rewrite_script`, `extract_assets`, art-bible, visual-lock, setting-brief,
style/color/motion locks, MV story/script, subtitle translation). Only the
big-ticket image/video stages (portraits, storyboards, frames, videos,
scene-images) carry a `quote_*`; the other metered steps have no quote and bill
by usage — 402 mid-run if the balance can't cover them (never overdraft).

## Execution tiers — when to just do it vs. when to ask

Don't ask the user at every step. Sort work into three tiers:

1. **Project settings — free; do them first; don't ask.** `project_type`,
   `setting_brief` (worldview / ERA LOCK), `ethnicity`, aspect & resolution, and
   the consistency anchors (`cinematography_prompt`, `art_bible`, `visual_lock`,
   `video_style_prompt`) are all free and the foundation that steers every later
   generation. Set them up front via `create_drama` / `update_project_settings`
   — don't build an empty shell, or all downstream generation drifts.
   **Never pin a specific character's wardrobe / hair / look inside
   `visual_lock` or `art_bible`** — those hold scene-level and world-level locks
   only. The **single source of truth** for a character's appearance is the
   character profile that `extract_assets` produces (edit it via
   `update_character`). Writing appearance in both places guarantees they
   contradict: portraits follow the profile, sheets follow the lock, and the
   consistency gate then rejects the sheet against the portrait **every single
   retry** — a structural dead loop that only burns money.
2. **Pipeline backbone — metered; in order; quote-then-confirm.** portraits →
   frames → videos → TTS → compose. Spending stages follow the normal
   quote → show the user → confirm flow (discipline 2).
3. **Optional boosts — metered; proactively offer them.** world concept,
   art-bible generation, scene images, scene groups, lipsync, posters/covers,
   SFX, BGM, subtitle translation. These lift consistency/quality but aren't
   required to finish an episode. **Proactively tell the user they're available
   and show a quote, then run on their OK** — neither silently skip them nor
   auto-charge.

## The eleven disciplines (hard rules)

These are not suggestions. Violating them wastes the user's money or produces
content that will be rejected.

1. **Prepaid — never overdraft.** The account can never go negative. Before a
   large spend, if unsure of balance, call `get_budget_status` /
   `get_cost_estimate`. On `402 insufficient_credits` (carries `needed`), STOP
   and tell the user to recharge. Never loop-retry a 402 — it will never
   succeed and only spins.

2. **Quote before you spend; the quote is the charge.** Big-ticket stages
   (portraits, storyboards, frames, videos, scene-images) are `quote_*` then
   `generate_*` — show the quote and get an explicit yes; for video, quote ==
   actual charge. Other AI-generation steps (TTS, posters, sheets, style locks,
   MV story/script …) have no quote and bill by usage — still tell the user
   before running them. Never auto-approve large spends on the user's behalf.

3. **`retryable` decides retry-vs-change — never blind-retry.** On failure read
   the structured `fail_reason` / `retryable` (from `get_storyboards`) or the
   `message` / `error.type`. `retryable:false` (moderation, copyright, quota,
   overdue) → change the content or stop; retrying is useless. `retryable:true`
   (KYC-queuing, rate-limit, transient) → back off, then retry.

4. **Content must be compliant.** Do not generate copyrighted characters,
   trademarks, real-person likenesses, or sensitive content. On a moderation /
   copyright rejection, rewrite toward **generic, original** imagery — do not
   fight the gate by retrying the same prompt.

5. **Voice cloning requires consent.** Only clone a voice from a sample the
   user is authorized to use (their own voice, or a rights-holder's written
   consent). `clone_voice` is billed per voice (auto-refunded on failure).
   Never clone a public figure's or third party's voice without authorization.
   Cloning needs **no character and no drama** — `clone_voice` returns a
   `voice_id` (e.g. `lib:12`) you can immediately audition with
   `speak_with_voice` (any text → downloadable audio URL). Bind it to a
   character with `set_character_voice` only when you actually need it to
   dub a shot. Always pass that same `voice_id` — never a raw number from
   somewhere else.

6. **Follow the pipeline order — do not skip.** `set_script` → `rewrite_script`
   → `extract_assets` → portraits **+ sheets** → storyboards → frames → videos.
   **The rewrite step is mandatory and server-enforced**: put your raw material
   (outline, synopsis, or even a finished script you wrote) into `set_script`,
   then run `rewrite_script` — the platform rewrite produces a shootable draft
   that stays self-consistent with the character profiles and storyboards built
   from it. Pasting your own script straight into `edit_rewritten_script` to
   skip the rewrite gets a 400 (no rewritten draft exists to edit), and
   `extract_assets` likewise requires the rewritten draft. After the rewrite,
   make every change in the AI output's structured format: polish the draft with
   `edit_rewritten_script`, edit character profiles with `update_character`,
   edit shots with `update_shot` / `replace_shot_dialogue` — never rewrite the
   whole script out-of-band or duplicate its facts into settings fields. Always
   generate frames **before** videos; skipping frames degrades video into
   anchorless t2v — wasted money. Lock character portraits **and sheets** before
   video: a portrait is one image, but **character sheets (multi-view turnarounds)
   are the shot consistency anchor every frame references** — portraits alone
   leave characters drifting across angle / lighting / wardrobe.
   `generate_portraits_and_sheets` does both (portraits first, then sheets). `generate_frames` makes **first frames only** by default — you do
   NOT generate first + last together. A **last frame** is optional and never
   auto-made; ask for one only to pin a shot's ending (a big camera move or
   reveal), via `generate_frames` with `frame_type=last_frame` or, for a single
   shot, `generate_shot_frame`. `generate_videos` needs at
   least one first frame in the episode.
   **Image model**: images use a drama-level model (default **Nano Banana 2** =
   `gemini-3.1-flash-image`), set via `create_drama` / `update_project_settings`
   field `image_model` for one consistent look across the whole drama;
   `generate_frames` / `generate_shot_frame` may override per call. Options:
   `gemini-3-pro-image` (Nano Banana Pro, finer, pricier), `gemini-3.1-flash-lite-image`
   (Lite, cheap), `doubao-seedream-5-0-260128` (Seedream 5.0), `gpt-image-2`.
   **Video engine**: videos use a drama-level engine, set via `create_drama` /
   `update_project_settings` field `video_engine`. Four options — surface the
   choice to the customer with the price gaps and let them decide:
   `seedance-2.5` (default; full capability: frame chain / scene groups /
   in-place edit / extend / reference anchors; 720p ≈ 212 pts/s);
   `hailuo-3` (MiniMax H3; ≈1/3 cost at 70 pts/s for 720p; native dialogue &
   SFX baked in; up to 2K; ~6 min per shot; in-place edit — high fidelity —
   and episode extend supported, input video billed per second on top);
   `wan3.0` (WAN 3.0; ≈40% cost at 84 pts/s for 720p; native dialogue & SFX;
   up to 1080P; up to 30s per shot and bills from 2s — no 4s floor; ~2 min
   per shot; in-place edit — strong semantic, background may follow the
   instruction — and episode extend supported, input video billed per second;
   ⚠ realistic human faces at 720p+ may be rejected by vendor moderation, so
   prefer it for stylized/animated dramas, empty shots and product shots);
   `wan3.0-prime` (same capability as wan3.0, ~2× faster, 1.5× rate =
   126 pts/s at 720p). Keyframe groups and time-range edit are not available
   on hailuo-3 / wan3.0 / wan3.0-prime — `edit_video_shot` rejects
   `start_sec`/`end_sec` on them. `edit_video_shot` also takes a per-call
   `model` so one shot can be edited on a different engine than the drama's.
   **How to choose (guide the customer proactively)**: ① realistic live-action
   dramas → `seedance-2.5` (best instruction-following and face detail), or
   `hailuo-3` to cut cost to ~1/3 (slower, ~6 min/shot); ② stylized / animated /
   3D-cartoon dramas, empty shots and product shots → `wan3.0` (~40% cost,
   2s-minimum billing), or `wan3.0-prime` when delivery speed matters;
   ③ NEVER pick wan3.0/prime for realistic live-action — WAN's output
   moderation consistently rejects realistic human faces at 720p+ and retries
   don't help. **Resolution by engine** (`video_resolution`): drafts/iteration →
   480p on WAN dramas (cheapest) or 720p elsewhere; final delivery →
   seedance stays 720p (HD tiers off sale), hailuo-3 → 1080p (= 2K, 112 pts/s),
   WAN → 1080p (168 pts/s). hailuo-3 has no separate 480p tier (a 480p request
   still bills at 768P).
   **Set the drama engine before generating any video**:
   switching never re-renders existing shots, and mixing engines inside one
   drama risks style/identity drift.
   **Images are slow** (tens of seconds to minutes each; a whole episode can take
   10+ min): poll `get_storyboards` and read `frame_status` — `pending` = still
   generating (keep waiting, NEVER re-call generate_frames — that double-charges),
   `ready` = done, `failed` = the only real failure. Never treat a slow image as failed.

   **Redraw on-platform, never off-platform.** When a shot's image is wrong,
   fix it with `quote_shot_frame` → `generate_shot_frame` (`frame_type`:
   `first_frame` / `last_frame` / `both`). That path carries the shot's character
   identity anchors, scene/prop references, style lock and frame audit, so the new
   image still matches the rest of the film. Do **not** render the image in another
   image tool and push it in with `upload_shot_frame` — that bypasses every anchor
   (faces, wardrobe and style drift) and makes you hostage to that tool's queue.
   `upload_shot_frame` is for art the customer already owns.

7. **Poll, don't block; don't hammer.** Long steps return immediately as
   `status:generating`. Poll `get_pipeline_status` / `get_jobs` /
   `get_storyboards` with a backoff (start ~5–10s, widen on no change). Stable
   counts = done. Do not tight-loop the API.

8. **Idempotency — don't double-charge.** A `quote_id` is one-time and expires
   in ~15 min; never reuse it or call `generate_*` twice for the same intent.
   Before regenerating an asset, read its current state first — don't re-pay for
   something already produced.

9. **Stay in your tenant.** You only ever see your own resources. Someone
   else's id returns `404` by design (cross-tenant probes never leak
   existence). Do not guess ids.

10. **Be transparent; keep secrets safe.** Report the quote, the failure
    reason, and what was actually spent — never fabricate success. Keep the API
    key in an environment variable or secrets manager, never in code or logs.
    The 15-min token auto-re-exchanges; a leaked key is revoked in Settings.

11. **Review every layer before you spend on the next one — free, and three of
    them are enforced.** Never run the pipeline straight through from
    `rewrite_script` to `compose_episode`. A flaw in the rewritten draft gets
    copied into character profiles, then storyboards, then frames, then video —
    by the time you see it in the final cut, the whole episode has to be redone,
    and every redo is another real charge. Reviewing costs nothing.

    **Three hard gates** (the server returns `400` if you skip them):

    | After you produce | Run | Before you call |
    |---|---|---|
    | the rewritten draft | `review_script` | `extract_assets`, `generate_storyboards` |
    | storyboards | `review_storyboards` | `generate_frames` |
    | shot frames | `review_frames` | `generate_videos` |

    Each review returns `{ pass, error_count, warning_count, findings[],
    review_token }`. Every finding carries `code` (problem type), `shots`
    (which shot numbers), and `action` (which tool fixes it) — relay them to the
    user verbatim, fix per `action`, then re-review. Pass the `review_token` to
    the downstream `generate_*` call. If the artifact changes after the review,
    the token expires by design — just re-review (still free). When a review has
    errors the gate holds; only pass `acknowledge_review: true` when the user
    knows what's wrong and explicitly chooses to proceed anyway. Never make that
    call for them.

    **Soft checkpoints** (not enforced, also free, still expected): `run_precheck`
    before any image or video generation (it catches shots the vendor will
    reject — pure wasted spend otherwise); `get_health_report` after
    storyboards; `get_characters` after portraits to confirm every on-screen
    character has an image and a sheet; `get_storyboards` after frames and after
    videos to read `frame_status` / `video_status` / `fail_reason` / `fail_hint`
    and fix failed shots before moving on; `get_pipeline_status` before the
    final cut to confirm no shot is missing. `review_all` gives a whole-episode
    checkup at any time (it issues no token — the gates want a review of the
    *current* artifact).

## Script fidelity — auto two-pass rewriting

`rewrite_script` routes automatically based on what the user put into
`set_script`:

- **Source is already a screenplay** (scene headers / dialogue-line structure):
  the platform runs a two-pass fidelity rewrite. The user's dialogue is
  byte-locked by machine gates (a missing line is rejected and redone
  internally — you never need to babysit this), and the AI adds **no** hooks,
  twists, or emotional beats of its own. Dramaturgy gaps it detects come back
  in `get_script` → `dramaturgy_suggestions`; relay them to the user and let
  the user decide. Ignoring them blocks nothing.
- **Source is a novel or outline**: the creative single-pass rewrite runs as
  before (the AI builds hooks and emotional beats).

Overrides via `update_project_settings`: `rewrite_pipeline`
(`auto` default / `two_pass` force fidelity / `single_forced` force creative)
and `fidelity_enforce: 1` (hard-reject any rewrite that drops a dialogue line,
a cast member, or an action beat).

When the user complains "the AI rewrote my script off course": ① confirm the
full original went into `set_script`; ② set `rewrite_pipeline: "two_pass"` and
rerun `rewrite_script`; ③ once the user approves a character's look, lock it
with `update_character` `profile_locked: 1` so later extractions can't
overwrite appearance (appearance anchors the portrait and face lock — an
overwrite means face drift across the whole drama).

## After the first rewrite — 点改优先 (point-edit, don't re-run)

**`rewrite_script` is "start over from the source", not "give me another
revision."** Once a draft exists, re-running it overwrites the current draft
together with every fix already made — and the new version does **not**
inherit what the previous one got right. Measured across three production
runs of the same episode: a long VO block correctly split in v2 was merged
back in v3, and era-correct wardrobe in v2 drifted a decade in v3. The
kickoff response says so explicitly via `overwrites_existing_script: true`.

So after the first successful rewrite, **every** change goes through
`edit_rewritten_script` — free, seconds, deterministic:

1. `get_script` → take the **full** `rewritten_script`.
2. Change **only the scenes that need changing** — split an over-long scene,
   fix a line, drop a `motif` that has no matching visual, add a missing
   `[SFX]`, move a hand-held object out of the wardrobe segment into the
   scene's `[道具]` line. Every other scene is copied back **verbatim**,
   punctuation included.
3. Submit the **whole** script to `edit_rewritten_script` (it is a full-text
   write, so untouched parts must come back unchanged — never send a fragment,
   and never let the model "tidy up" scenes it wasn't asked to touch).

Re-run `rewrite_script` only when the user genuinely wants a different take on
the whole episode. If a re-run (or an edit) went wrong,
`get_script` with `include_previous: true` returns the previous draft snapshot.

Point-editable by definition — anything the platform can already name: scene
length, cross-shot dialogue splits, wrong time-of-day or era, orphan motifs,
props in the wardrobe segment, missing `[SFX]`/`[BGM]`, group-shot head counts.
Storyboard-level issues do **not** need a script edit at all: use
`update_shot` / `replace_shot_dialogue`.

## Failure playbook

Failures surface as a human-readable `message` (MCP throws `Error(message)`;
REST returns `{ code, message }`, or on `/v1/ai/*`:
`{ error: { message, type, needed?, retryable? } }`). Per-shot, `get_storyboards`
gives structured `frame_status` / `video_status` / `fail_reason` / `retryable` /
`fail_hint`. A status of `not_required` marks a narration/end-card shot: its frame
and video are rendered by the final-cut layer — count it as done, never retry it.
Map the reason to an action:

| fail_reason | retryable | What it means | Do |
|---|---|---|---|
| `sensitive` | false | Frame hit content moderation | Change the picture / swap reference, regenerate |
| `text_sensitive` | false | The **prompt text** was flagged (no charge) | Reword the prompt (not the image), retry |
| `copyright` | false | Copyright / trademark / real-person likeness | Switch to generic original imagery |
| `face_mismatch` | false | Portrait ≠ the authorized person | Swap the portrait / confirm same person |
| `account_overdue` | false | Upstream vendor account overdue (platform-level) | Not self-healable — tell the user; do **not** touch the prompt |
| `quota_full` | false | Platform vendor-asset quota exhausted | Retry won't help — contact ops |
| `insufficient_credits` | false | Balance too low for this call | Stop, prompt to recharge (402) |
| `authorizing` | true | Face frame queuing for KYC (not a rejection) | Wait ~1 min, retry |
| `transient` | true | BestOfN / quality-gate / rate-limit / network | Back off, retry |
| `unknown` | false | Unclassified | Read `fail_hint`; don't auto-retry |

Three action classes, one decision: **moderation / identity / copyright → change
content**; **overdue / token → not self-healable (tell user / wait)**; **network
/ timeout / transient → retry**. Failed spends are auto-refunded (pre-hold →
refund on failure); you never compensate manually.

## Quality-complaint triage (the cut looks/sounds wrong)

The table above is for **generation failures**. A different class of report is
"the video generated fine, but the cut is wrong." These never surface as a
`fail_reason` — nothing failed. Diagnose by symptom:

### "话没说完就切" / a line gets cut off mid-word

Three distinct causes; check in this order, they need opposite fixes.

1. **The line moved after the video was made.** If you edited `dialogue` on a
   shot whose video already existed, the video still speaks the *old* line —
   for native-audio engines the voice is baked into the picture. Symptom that
   gives it away: the line seems to have "jumped to a different shot."
   `compose_episode` reports these as advisory `stale_video_after_edit`.
   **Fix:** `regenerate_shot_video` those shots, then compose. Never just
   re-compose — no amount of re-cutting can change what the video says.
2. **The vendor never said the whole line.** When a shot is too short for the
   line, native-audio engines just stop where they stop. Check the shot's own
   clip, not the final cut. **Fix:** lengthen the shot (`update_shot.duration`)
   and regenerate, or split it (`split_shot`).
3. **The transition ate the tail.** A cross-fade pulls the *next* shot's start
   backwards, covering the end of the current one. The platform now shortens or
   drops that transition automatically so it can never cover a spoken word, so
   you should not see this any more — if you do, report it.

### "切太快" / "一个镜头里画面跳来跳去"

Run **`scan_intra_shot_cuts`** (free) before touching anything. What a viewer
perceives as cutting speed is *shot seams + cuts the vendor made inside a single
shot*, and the second half is invisible in the shot list, in the timeline, and
in every duration number you can read back. If `shots_with_cuts` covers most of
the episode, re-cutting, re-pacing or changing transitions will not help — the
extra cuts are inside the clips themselves.

`engine_suspect: true` means the drama runs on WAN, the known high-rate source:
measured **11/12 shots** with intra-shot cuts, versus 1/6 on seedance-2.5 and
0/5 on hailuo-3. Prompt-level constraints do not stop it (the negative
constraint is already in the prompt and was measured ineffective). The only
real fix is `regenerate_shot_video` on those shots after switching the drama to
`seedance-2.5` or `hailuo-3`.

### "画面里多出一个人 / 多出一件道具" — something appears that shouldn't be there

Two completely different causes with opposite fixes. **Look at the shot's own
first frame before doing anything** (`get_storyboards` → the frame image):

1. **The frame itself already contains the extra thing.** Then the vendor did
   nothing wrong — it faithfully animated what you gave it. This happens when a
   frame was regenerated but something downstream still held the older image.
   **Fix:** regenerate the frame until it's clean, then regenerate the video.
   Rewriting the shot text does *not* help here — a line like "keeps holding the
   same single sword" cannot argue a second sword out of the picture. (The
   platform now always anchors video on the shot's *current* stored frame, so a
   stale image can no longer sneak in from a caller's cached copy.)
2. **The frame is clean and the extra thing grows in mid-clip.** That's drift
   during generation, and **shot length is the biggest driver**: a long
   single-shot gives the model room to invent. Measured case — a 16-second shot
   whose neighbours were all 3–5 seconds: the room changed four times, the child
   vanished for four seconds and then regrew from the edge of frame as a new
   figure. **Fix:** split it (`split_shot`) into 3–5 second shots and regenerate;
   on WAN also consider switching engine (see below).

Keep single shots in the 3–5 second range unless you have a specific reason.
If you find yourself authoring a 15s+ shot, that is the thing to fix first —
no prompt wording compensates for handing the model that much freedom.

One more propagation path: when shots are generated as a continuation chain, a
shot can be anchored on the **previous shot's finished video**. A wrong shot
therefore infects the next one, and r2v copies it faithfully. So fix the
*earliest* bad shot in a run first, then regenerate the ones after it — don't
start in the middle.

### Choosing an engine so this never comes up

Pick the engine **before** generating video — switching does not retroactively
fix shots already made. For anything with dialogue and a story to follow, use
`seedance-2.5` (or `hailuo-3` to cut cost). Reach for `wan3.0` when the shots
are short and stylised — animation, 3D cartoon, empty/scenery shots, product
shots — where an extra angle change inside a shot does not read as a mistake.
Two hard limits on WAN: realistic human faces at 720p+ are rejected outright by
vendor moderation, and it re-cuts inside shots as described above.

Also: `cinematography_prompt` is injected into **every single shot**. Write
single-shot photographic properties there (lens, depth of field, lighting,
grade). Writing a whole-episode camera sequence ("aerial wide to open … silhouette
to close") tells the vendor to fit that entire sequence into each 3-second shot.

## Quick tool reference

- **Discover / create**: `list_project_options`, `create_drama`,
  `update_project_settings`
- **Script**: `set_script`, `rewrite_script`, `get_script`,
  `edit_rewritten_script`, `extract_assets`
- **Identity & consistency**: `generate_character_portraits`, `upload_image`,
  `set_character_portrait`, `generate_character_sheet`, `extract_visual_lock`
- **Shots → video**: `quote/generate_storyboards`, `get_storyboards`,
  `quote/generate_frames`, `chain_frames`, `quote/generate_videos`
- **Audio**: `generate_tts` (required before final cut), `clone_voice`,
  `speak_with_voice`, `set_character_voice`, `list_voices`, `delete_voice`,
  `generate_bgm`, `replace_shot_dialogue`
- **Finish**: `compose_episode`, `get_final_cut`, `get_export`,
  `generate_episode_poster`, `generate_cover`
- **Assemble it yourself**: `export_handoff_pack`, `get_handoff_toolchain` —
  download the per-shot raw clips, dialogue tracks, SFX, BGM and subtitles, then
  decide transitions and assemble the cut on your own side. Use this instead of
  `compose_episode` when you want to judge each seam yourself; use
  `compose_episode` when you want the platform's finishing pipeline (pre-flight
  checks, A/V duration parity, loudness mastering). Three facts that will bite you:
  `audio_contract.mode="tts"` means the raw clips have **no voice** (dialogue ships
  separately — skip it and the episode is silent); every shot must be cut to
  `trim_head_ms`/`duration_ms` or you splice in frames the platform already QC'd out;
  and all subtitle/dialogue/SFX offsets are relative to **each shot's own trimmed
  start**, not to the final timeline — add whatever overlapping transitions you like
  and let `compile_timeline.py` expand them, never hand-compute the shift.
- **Edit**: `edit_video_shot`, `regenerate_shot_video`, `split_shot`,
  `trim_shot`, `rerender_episode`
- **Read back (all free)**: `list_dramas`, `get_drama`, `get_characters`,
  `get_scenes`, `get_assets`, `get_jobs`, `get_pipeline_status`,
  `get_cost_estimate`, `get_budget_status`
- **Cut QA (all free)**: `scan_intra_shot_cuts` (vendor cutting inside a shot —
  run this first on any "切太快" report), `recommend_trim_window` (action ends up
  outside the kept window)

Full reference: https://api.shortreelai.com/docs/mcp
