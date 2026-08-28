#!/usr/bin/env python3
"""
compile_timeline.py — 镜相对锚点 → 绝对时间码 编译器（参考实现 v0.1）

素材包里的字幕/对白/音效时间全部是「相对该镜 trim 后起点」的。第三方自己拼片、
自己加转场后，用本脚本把它们展开成自己时间轴上的绝对时间码。

核心公式（唯一真相，改转场只改这里）：
    in_ms[0] = 0
    in_ms[i] = in_ms[i-1] + duration_ms[i-1] - overlap_ms[i]
其中 overlap_ms[i] = 第 i 镜与上一镜的画面重叠量（硬切=0，叠化=转场时长）。
重叠会让其后每一镜整体提前，误差累积——所以绝不要手算，交给这个脚本。

用法:
    python3 compile_timeline.py <包目录> [--transitions plan.json] [--outdir build]

转场计划 plan.json（可选，不给则全片硬切）:
    { "transitions": [ { "before_shot": 3, "type": "dissolve", "overlap_ms": 300 } ] }
    before_shot = 该镜与它上一镜之间的转场；overlap_ms 只对重叠式转场 > 0。

产物:
    build/offsets.json   每镜绝对入点 + 总时长 + BGM 入点（assemble.sh 消费）
    build/episode.srt    整集字幕（已按各镜入点偏移合并）
"""
import argparse, json, os, re, sys

# ── 转场预设表 ─────────────────────────────────────────────────────────────
# 与平台 services/timeline/transition-presets.ts 保持一致。改平台那份时同步这里。
#   xfade  = ffmpeg xfade transition 名
#   render = "xfade"（两镜重叠）| "baked-cut"（硬切 + 入场闪光，**不重叠**）
PRESETS = {
    "cut":          {"xfade": None,         "ms": 0,   "render": "cut"},
    "fade":         {"xfade": "fade",       "ms": 500, "render": "xfade"},
    "dissolve":     {"xfade": "dissolve",   "ms": 700, "render": "xfade"},
    "fade_black":   {"xfade": "fadeblack",  "ms": 600, "render": "xfade"},
    "wipe_left":    {"xfade": "wipeleft",   "ms": 500, "render": "xfade"},
    "circle_open":  {"xfade": "circleopen", "ms": 600, "render": "xfade"},
    "flash_white":  {"xfade": "fadewhite",  "ms": 130, "render": "baked-cut", "flash": "white"},
    "flash_black":  {"xfade": "fadeblack",  "ms": 130, "render": "baked-cut", "flash": "black"},
    "zoom_punch":   {"xfade": "zoomin",     "ms": 350, "render": "xfade"},
    "whip_pan":     {"xfade": "hrwind",     "ms": 130, "render": "xfade"},
    "glass_shatter":{"xfade": "distance",   "ms": 500, "render": "xfade"},
    "swirl":        {"xfade": "radial",     "ms": 700, "render": "xfade"},
    "invert_flash": {"xfade": "fadeblack",  "ms": 320, "render": "xfade"},
    "radial_open":  {"xfade": "radial",     "ms": 650, "render": "xfade"},
}

# Wave11 导演语义键 → 预设 id。j_cut / l_cut 是纯音轨编辑，视觉上就是硬切。
W11_TO_PRESET = {
    "hard_cut": "cut", "j_cut": "cut", "l_cut": "cut",
    "match_cut": "dissolve", "graphic_match": "dissolve", "cross_dissolve": "dissolve",
    "whip_pan_trans": "whip_pan", "smash_cut": "flash_white",
    "iris_in": "circle_open", "time_lapse_in": "dissolve",
}

# 平台 v0.9.81 下架：叠化 ≥600ms 的 xfade 类在**有对白的接缝**会做长音频交叉淡化 →
# 卡壳（客户实测确认）。这里不禁用，但会警告并给出安全等价替代。
DEPRECATED = {"dissolve", "fade_black", "circle_open", "swirl", "radial_open"}
SAFE_REPLACEMENT = {
    "dissolve": "fade", "circle_open": "fade",
    "swirl": "flash_black", "fade_black": "flash_black", "radial_open": "flash_black",
}


def resolve_preset(name):
    """转场名（预设 id / Wave11 语义键 / 裸 xfade 名）→ 预设。未知退 fade。"""
    k = str(name or "").strip().lower()
    if not k:
        return "cut", PRESETS["cut"]
    if k in W11_TO_PRESET:
        k = W11_TO_PRESET[k]
    if k in PRESETS:
        return k, PRESETS[k]
    for pid, p in PRESETS.items():          # 允许直接给 ffmpeg xfade 名
        if p["xfade"] == k:
            return pid, p
    return "fade", PRESETS["fade"]


# ── SRT ────────────────────────────────────────────────────────────────────
TS = re.compile(r"(\d+):(\d{2}):(\d{2})[,.](\d{3})")


def parse_srt(path):
    """→ [(start_ms, end_ms, text)]。时间码基准 = 该镜 trim 后的第 0 毫秒。"""
    if not path or not os.path.exists(path):
        return []
    blocks = re.split(r"\n\s*\n", open(path, encoding="utf-8-sig").read().strip())
    cues = []
    for b in blocks:
        lines = [l for l in b.splitlines() if l.strip()]
        if len(lines) < 2:
            continue
        arrow = next((l for l in lines if "-->" in l), None)
        if not arrow:
            continue
        stamps = TS.findall(arrow)
        if len(stamps) != 2:
            continue
        to_ms = lambda t: (int(t[0]) * 3600 + int(t[1]) * 60 + int(t[2])) * 1000 + int(t[3])
        text = "\n".join(lines[lines.index(arrow) + 1:])
        cues.append((to_ms(stamps[0]), to_ms(stamps[1]), text))
    return cues


def fmt_ms(ms):
    ms = max(0, int(ms))
    h, ms = divmod(ms, 3600000)
    m, ms = divmod(ms, 60000)
    s, ms = divmod(ms, 1000)
    return f"{h:02d}:{m:02d}:{s:02d},{ms:03d}"


def write_srt(path, cues):
    with open(path, "w", encoding="utf-8") as f:
        for i, (a, b, t) in enumerate(cues, 1):
            f.write(f"{i}\n{fmt_ms(a)} --> {fmt_ms(b)}\n{t}\n\n")


# ── 编译 ───────────────────────────────────────────────────────────────────
def compile_timeline(pack_dir, plan_path=None, outdir=None):
    manifest = json.load(open(os.path.join(pack_dir, "manifest.json"), encoding="utf-8"))
    if manifest.get("manifest_version") != "0.1":
        sys.exit(f"不认识的 manifest_version: {manifest.get('manifest_version')!r}，拒绝猜测")

    overlaps, trans = {}, {}
    if plan_path:
        plan = json.load(open(plan_path, encoding="utf-8"))
        for t in plan.get("transitions", []):
            n = int(t["before_shot"])
            pid, p = resolve_preset(t.get("type"))
            # overlap 缺省取预设的规范时长；baked-cut 强制 0（硬切 + 入场闪光）
            ov = int(t["overlap_ms"]) if t.get("overlap_ms") is not None else p["ms"]
            if p["render"] != "xfade":
                ov = 0
            overlaps[n] = max(0, ov)
            trans[n] = {
                "preset_id": pid, "xfade": p["xfade"],
                "render": p["render"], "flash": p.get("flash"),
            }

    rules = manifest.get("assembly_rules", {})
    cap = int(rules.get("transition_budget_ms_max", 400))
    floor = int(rules.get("min_shot_duration_ms", 800))

    shots, cursor, cues, warnings = [], 0, [], []
    prev_dur = None
    for sh in manifest["shots"]:
        n = int(sh["shot_number"])
        dur = int(sh["clip"]["duration_ms"])
        ov = overlaps.get(n, 0)

        if prev_dur is not None and ov:
            # 重叠不得超过预算，也不得吃掉相邻任一镜的最短时长
            limit = min(cap, prev_dur - floor, dur - floor)
            if ov > max(0, limit):
                warnings.append(f"镜 {n}: 重叠 {ov}ms 超限，钳到 {max(0, limit)}ms")
                ov = max(0, limit)
            # 可借冗余 = 上一镜的「镜末静音留白 + 被掐掉的尾部」。
            # ★ silence_after_ms 默认是 0（authoring 字段，只有 AI 填过或项目设了
            #   pacing_curve 才非零），所以真正能借的通常是 trim_tail_ms 那 250ms。
            #   重叠超出这个预算 = 重叠期压在对白上，声画归属模糊。
            prev = shots[-1]
            budget = int(prev.get("silence_after_ms", 0)) + int(prev.get("trim_tail_ms", 0))
            if ov > budget:
                warnings.append(
                    f"镜 {n}: 重叠 {ov}ms 超出上一镜可借冗余 {budget}ms"
                    f"(静音留白 {prev.get('silence_after_ms', 0)} + 掐掉的尾部 {prev.get('trim_tail_ms', 0)})，"
                    f"重叠期会压到对白，建议降到 {budget}ms 或改硬切")
            cursor -= ov

        in_ms = cursor if prev_dur is not None else 0
        tr = dict(trans.get(n) or {"preset_id": "cut", "xfade": None, "render": "cut", "flash": None})
        if tr["preset_id"] in DEPRECATED:
            warnings.append(
                f"镜 {n}: 转场 {tr['preset_id']} 已在平台下架（长叠化在有对白接缝会卡壳），"
                f"建议改用 {SAFE_REPLACEMENT.get(tr['preset_id'], 'fade')}")
        tr["duration_ms"] = ov if tr["render"] == "xfade" else (
            PRESETS[tr["preset_id"]]["ms"] if tr["render"] == "baked-cut" else 0)

        shots.append({
            "shot_number": n,
            "transition": tr,
            "file": sh["clip"]["file"],
            "trim_head_ms": int(sh["clip"].get("trim_head_ms", 0)),
            "trim_tail_ms": int(sh["clip"].get("trim_tail_ms", 0)),
            "duration_ms": dur,
            "in_ms": in_ms,
            "overlap_ms": ov,
            "has_baked_audio": bool(sh["clip"].get("has_baked_audio")),
            "silence_after_ms": int(sh.get("padding", {}).get("silence_after_ms", 0)),
            "dialogue": sh.get("dialogue_audio"),
            "sfx": sh.get("sfx", []),
        })

        # 字幕：镜内相对 → 绝对。一次加法，位移问题在此消失。
        sub = (sh.get("subtitle") or {}).get("file")
        for a, b, t in parse_srt(os.path.join(pack_dir, sub) if sub else None):
            cues.append((in_ms + a, in_ms + b, t))

        cursor = in_ms + dur
        prev_dur = dur

    total = cursor
    by_n = {s["shot_number"]: s for s in shots}
    bgm = []
    for b in manifest.get("bgm", []):
        anchor = by_n.get(int(b.get("anchor_shot", 1)))
        if not anchor:
            warnings.append(f"BGM {b.get('file')}: anchor_shot 不存在，按 0 处理")
        bgm.append({
            "file": b["file"],
            "in_ms": (anchor["in_ms"] if anchor else 0) + int(b.get("anchor_offset_ms", 0)),
            "gain_db": float(b.get("gain_db", -16)),
            "fade_in_ms": int(b.get("fade_in_ms", 0)),
            "fade_out_ms": int(b.get("fade_out_ms", 0)),
            "loop": bool(b.get("loop", True)),
        })

    out = {
        "total_ms": total,
        "render_target": manifest["render_target"],
        "audio_contract": manifest["audio_contract"],
        "shots": shots,
        "bgm": bgm,
        "warnings": warnings,
    }
    outdir = outdir or os.path.join(pack_dir, "build")
    os.makedirs(outdir, exist_ok=True)
    json.dump(out, open(os.path.join(outdir, "offsets.json"), "w", encoding="utf-8"),
              ensure_ascii=False, indent=2)
    write_srt(os.path.join(outdir, "episode.srt"), sorted(cues, key=lambda c: c[0]))

    print(f"总时长 {total/1000:.2f}s · {len(shots)} 镜 · {len(cues)} 条字幕 → {outdir}")
    for w in warnings:
        print("  ⚠️ " + w, file=sys.stderr)
    return out


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("pack_dir")
    ap.add_argument("--transitions")
    ap.add_argument("--outdir")
    a = ap.parse_args()
    compile_timeline(a.pack_dir, a.transitions, a.outdir)
