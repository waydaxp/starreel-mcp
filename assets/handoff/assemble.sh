#!/usr/bin/env bash
# assemble.sh — 素材交接包装配参考实现 v0.1（硬切基线）
#
# 先跑通这个基线，再去改转场。它证明素材包是完整的：拼接、对白、音效、配乐、
# 字幕、响度六件事全部到位，音画同步。转场是唯一留给你改的东西。
#
# 用法:
#   ./assemble.sh <包目录> [输出文件] [转场计划.json]
#
# 依赖: ffmpeg (≥4.4), ffprobe, jq, python3
set -euo pipefail

PACK="${1:?用法: assemble.sh <包目录> [输出文件] [转场计划.json]}"
OUT="${2:-episode_out.mp4}"
PLAN="${3:-}"
BUILD="${PACK}/build"
TMP="${BUILD}/tmp"
mkdir -p "${TMP}"

for bin in ffmpeg ffprobe jq python3; do
  command -v "${bin}" >/dev/null || { echo "缺少依赖: ${bin}" >&2; exit 1; }
done

# 字幕烧录需要 ffmpeg 编译时启用 libass。很多发行版/homebrew 的 ffmpeg 没带，
# 且缺失时 subtitles 滤镜直接不存在 —— 必须在这里查，不能等跑完四阶段转码才崩。
if ffmpeg -hide_banner -filters 2>/dev/null | grep -qE '[[:space:]]subtitles[[:space:]]'; then
  HAS_LIBASS=1
else
  HAS_LIBASS=0
  echo "注意: 本机 ffmpeg 未启用 libass（无 subtitles 滤镜），字幕将以软字幕轨输出而非烧录。" >&2
  echo "      要烧录字幕请装带 libass 的 ffmpeg：brew install ffmpeg 或自行 --enable-libass 编译。" >&2
fi

# ── 阶段 1：编译时间轴（镜相对锚点 → 绝对时间码）────────────────────────────
echo "==> [1/6] 编译时间轴"
if [ -n "${PLAN}" ]; then
  python3 "$(dirname "$0")/compile_timeline.py" "${PACK}" --transitions "${PLAN}" --outdir "${BUILD}"
else
  python3 "$(dirname "$0")/compile_timeline.py" "${PACK}" --outdir "${BUILD}"
fi
OFF="${BUILD}/offsets.json"

W=$(jq -r '.render_target.width'  "${OFF}")
H=$(jq -r '.render_target.height' "${OFF}")
FPS=$(jq -r '.render_target.fps'  "${OFF}")
VB=$(jq -r '.render_target.video_bitrate' "${OFF}")
AB=$(jq -r '.render_target.audio_bitrate' "${OFF}")
MODE=$(jq -r '.audio_contract.mode' "${OFF}")
LN_I=$(jq -r '.audio_contract.loudnorm.I'   "${OFF}")
LN_TP=$(jq -r '.audio_contract.loudnorm.TP' "${OFF}")
LN_LRA=$(jq -r '.audio_contract.loudnorm.LRA' "${OFF}")
TOTAL_MS=$(jq -r '.total_ms' "${OFF}")
# 调色查找表：平台的 LUT 在终拼时施加，裸片是未调色的。有它就在规范化这一步顺手烤进去，
# 成片色彩才与平台一致。用 filter_complex 的真实输入而不是 movie= —— 后者要对路径里的
# 空格/冒号做转义，包目录一旦带空格就会静默失败。
LUT_REL=$(jq -r '.render_target.color_lut.file // empty' "${OFF}")
LUT_FILE=""
if [ -n "${LUT_REL}" ] && [ -f "${PACK}/${LUT_REL}" ]; then
  LUT_FILE="${PACK}/${LUT_REL}"
  echo "  调色查找表: ${LUT_REL}"
fi
NSHOTS=$(jq -r '.shots | length' "${OFF}")

# 有无重叠决定阶段 3 走哪条路：全硬切走 concat demuxer 快路径（-c copy，秒级）；
# 一旦有重叠就必须整图 filter_complex 重编码。
MAXOV=$(jq -r '[.shots[].overlap_ms] | max' "${OFF}")
[ "${MAXOV}" = "null" ] && MAXOV=0

ms2s() { awk -v m="$1" 'BEGIN{printf "%.3f", m/1000}'; }

# ── 阶段 2：逐镜规范化（trim + 统一编码 + 组装该镜音轨）─────────────────────
echo "==> [2/6] 规范化 ${NSHOTS} 个镜头"
: > "${TMP}/concat.txt"
for i in $(seq 0 $((NSHOTS - 1))); do
  S=$(jq -c ".shots[${i}]" "${OFF}")
  N=$(jq -r '.shot_number' <<<"${S}")
  SRC="${PACK}/$(jq -r '.file' <<<"${S}")"
  SS=$(ms2s "$(jq -r '.trim_head_ms' <<<"${S}")")
  DUR=$(ms2s "$(jq -r '.duration_ms' <<<"${S}")")
  BAKED=$(jq -r '.has_baked_audio' <<<"${S}")
  DST="${TMP}/shot_$(printf '%03d' "${N}").mkv"

  # 中间产物一律 mkv + pcm_s16le：aac 每段都带 ~21ms(1024 samples) 编码器 priming
  # delay，走 adelay/amix 时每镜音频会整体提前约半帧，重叠转场下误差还会叠加。
  # 只在阶段 4 最后一次编 aac。
  # 视频：先 trim 再统一到目标画布/帧率。scale+pad 保证不同源尺寸也能拼。
  VF="scale=${W}:${H}:force_original_aspect_ratio=decrease,pad=${W}:${H}:(ow-iw)/2:(oh-ih)/2,setsar=1,fps=${FPS}"

  # baked-cut（闪白/闪黑）：硬切 + 本镜片头快速过曝/压黑，**不重叠**。
  # 平台实测：这类效果走 xfade 会变成双重闪 + 130ms 重叠 + 口型/音频瞬断，
  # 所以它烤在片头、不进 xfade 链。
  RENDER=$(jq -r '.transition.render // "cut"' <<<"${S}")
  if [ "${RENDER}" = "baked-cut" ]; then
    FLASH=$(jq -r '.transition.flash // "white"' <<<"${S}")
    FMS=$(jq -r '.transition.duration_ms // 130' <<<"${S}")
    VF="${VF},fade=t=in:st=0:d=$(ms2s "${FMS}"):color=${FLASH}"
  fi

  INPUTS=(-ss "${SS}" -t "${DUR}" -i "${SRC}")
  if [ "${MODE}" = "clip" ] && [ "${BAKED}" = "true" ]; then
    # 裸片自带人声：直接用它的音轨，绝不再叠对白（叠了就是双声）
    if [ -n "${LUT_FILE}" ]; then
      ffmpeg -hide_banner -loglevel error -y "${INPUTS[@]}" -i "${LUT_FILE}" \
        -filter_complex "[0:v]${VF}[g];[g][1:v]haldclut[v]" \
        -map "[v]" -map 0:a:0? \
        -c:v libx264 -b:v "${VB}" -pix_fmt yuv420p -c:a pcm_s16le -ar 48000 -ac 2 \
        -shortest "${DST}"
    else
      ffmpeg -hide_banner -loglevel error -y "${INPUTS[@]}" \
        -vf "${VF}" -map 0:v:0 -map 0:a:0? \
        -c:v libx264 -b:v "${VB}" -pix_fmt yuv420p -c:a pcm_s16le -ar 48000 -ac 2 \
        -shortest "${DST}"
    fi
  else
    # TTS 模式：裸片无人声。静音底 + 对白 + 音效，全部按镜内 offset 落位。
    # 输入索引是固定契约：0=静音底  1=视频  2..=对白/音效（按下面的追加顺序）
    INPUTS=(-f lavfi -t "${DUR}" -i "anullsrc=r=48000:cl=stereo"
            -ss "${SS}" -t "${DUR}" -i "${SRC}")
    FILTER=""; LABELS="[0:a]"; IDX=2

    DLG=$(jq -c '.dialogue // empty' <<<"${S}")
    if [ -n "${DLG}" ] && [ "${DLG}" != "null" ]; then
      DOFF=$(jq -r '.offset_ms // 0' <<<"${DLG}")
      DGAIN=$(jq -r '.gain_db // 0' <<<"${DLG}")
      INPUTS+=(-i "${PACK}/$(jq -r '.file' <<<"${DLG}")")
      FILTER+="[${IDX}:a]adelay=${DOFF}|${DOFF},volume=${DGAIN}dB[d];"
      LABELS+="[d]"; IDX=$((IDX + 1))
    fi

    NSFX=$(jq -r '.sfx | length' <<<"${S}")
    for ((j = 0; j < NSFX; j++)); do
      X=$(jq -c ".sfx[${j}]" <<<"${S}")
      XOFF=$(jq -r '.offset_ms // 0' <<<"${X}")
      XGAIN=$(jq -r '.gain_db // 0' <<<"${X}")
      INPUTS+=(-i "${PACK}/$(jq -r '.file' <<<"${X}")")
      FILTER+="[${IDX}:a]adelay=${XOFF}|${XOFF},volume=${XGAIN}dB[x${j}];"
      LABELS+="[x${j}]"; IDX=$((IDX + 1))
    done

    # 混入静音底：amix 的 inputs = 底轨 + 对白 + 音效，normalize=0 保住各自增益
    NMIX=$((IDX - 1))
    FILTER+="${LABELS}amix=inputs=${NMIX}:normalize=0:dropout_transition=0[aout]"

    if [ -n "${LUT_FILE}" ]; then
      INPUTS+=(-i "${LUT_FILE}")
      ffmpeg -hide_banner -loglevel error -y "${INPUTS[@]}" \
        -filter_complex "${FILTER};[1:v]${VF}[g];[g][${IDX}:v]haldclut[v]" \
        -map "[v]" -map "[aout]" -t "${DUR}" \
        -c:v libx264 -b:v "${VB}" -pix_fmt yuv420p -c:a pcm_s16le -ar 48000 -ac 2 \
        "${DST}"
    else
      ffmpeg -hide_banner -loglevel error -y "${INPUTS[@]}" \
        -filter_complex "${FILTER}" \
        -map 1:v:0 -vf "${VF}" -map "[aout]" -t "${DUR}" \
        -c:v libx264 -b:v "${VB}" -pix_fmt yuv420p -c:a pcm_s16le -ar 48000 -ac 2 \
        "${DST}"
    fi
  fi
  echo "file '$(cd "$(dirname "${DST}")" && pwd)/$(basename "${DST}")'" >> "${TMP}/concat.txt"
done

# ── 阶段 3：拼接 ───────────────────────────────────────────────────────────
if [ "${MAXOV}" = "0" ]; then
  echo "==> [3/6] 拼接（全硬切，concat 快路径）"
  ffmpeg -hide_banner -loglevel error -y -f concat -safe 0 -i "${TMP}/concat.txt" \
    -c copy "${TMP}/cut.mkv"
else
  echo "==> [3/6] 拼接（含重叠转场，xfade 链）"
  # 视频：xfade 链。**offset 直接取编译好的 in_ms，绝不手算累加** —— 每个重叠都会
  # 让其后所有镜前移，手算的累积误差是这条路最常见的翻车原因。
  # 音频：不做 crossfade，每镜音轨 adelay 到自己的 in_ms 再 amix。这样音频时间轴
  # 与 xfade 后的视频天然一致；重叠量若落在上一镜镜末静音内，对白完全不受影响。
  VIN=(); VPRE=""; VCHAIN=""; ACHAIN=""; ALABELS=""; CUR="[p0]"
  for i in $(seq 0 $((NSHOTS - 1))); do
    S=$(jq -c ".shots[${i}]" "${OFF}")
    N=$(jq -r '.shot_number' <<<"${S}")
    VIN+=(-i "${TMP}/shot_$(printf '%03d' "${N}").mkv")
    IN_MS=$(jq -r '.in_ms' <<<"${S}")
    # settb=AVTB 是 xfade 的硬前提：xfade 要求两路输入 timebase 完全一致，而
    # concat filter 输出 1/1000000、解码器给的常是 1/12288 —— 不统一直接报
    # "timebase do not match"。★顺序不能反：fps 滤镜会把 timebase 重设成 1/fps，
    # 写成 settb,fps 等于白设，必须 fps 在前、settb 收尾。
    VPRE+="[${i}:v]fps=${FPS},format=yuv420p,settb=AVTB[p${i}];"
    ACHAIN+="[${i}:a]adelay=${IN_MS}|${IN_MS}[a${i}];"
    ALABELS+="[a${i}]"
    [ "${i}" -eq 0 ] && continue
    OV=$(jq -r '.overlap_ms' <<<"${S}")
    if [ "${OV}" -gt 0 ]; then
      XF=$(jq -r '.transition.xfade // "fade"' <<<"${S}")
      VCHAIN+="${CUR}[p${i}]xfade=transition=${XF}:duration=$(ms2s "${OV}"):offset=$(ms2s "${IN_MS}")[v${i}];"
    else
      VCHAIN+="${CUR}[p${i}]concat=n=2:v=1:a=0[v${i}];"
    fi
    CUR="[v${i}]"
  done
  ACHAIN+="${ALABELS}amix=inputs=${NSHOTS}:normalize=0:dropout_transition=0[aout]"
  ffmpeg -hide_banner -loglevel error -y "${VIN[@]}" \
    -filter_complex "${VPRE}${VCHAIN}${ACHAIN}" \
    -map "${CUR}" -map "[aout]" \
    -c:v libx264 -b:v "${VB}" -pix_fmt yuv420p -c:a pcm_s16le -ar 48000 -ac 2 \
    "${TMP}/cut.mkv"
fi

# ── 阶段 4：配乐 + 侧链避让 + 响度 ─────────────────────────────────────────
echo "==> [4/6] 配乐与混音"
# 限幅阈值 = 10^(TP/20)，与母带的 TP 目标同一个数
LIMIT=$(awk -v tp="${LN_TP}" 'BEGIN{printf "%.4f", 10 ^ (tp/20)}')
NBGM=$(jq -r '.bgm | length' "${OFF}")
if [ "${NBGM}" -gt 0 ]; then
  BI=(); BF=""; BL=""
  for i in $(seq 0 $((NBGM - 1))); do
    B=$(jq -c ".bgm[${i}]" "${OFF}")
    BI+=(-i "${PACK}/$(jq -r '.file' <<<"${B}")")
    BOFF=$(jq -r '.in_ms' <<<"${B}")
    BGAIN=$(jq -r '.gain_db' <<<"${B}")
    IDX=$((i + 1))
    BF+="[${IDX}:a]adelay=${BOFF}|${BOFF},volume=${BGAIN}dB[b${i}];"
    BL+="[b${i}]"
  done
  BF+="${BL}amix=inputs=${NBGM}:normalize=0[bgm];"
  # 侧链源必须是**只有人声的总线**，不能用前景总轨。音效混在 sidechain 里会
  # 让打击音/环境音也把 BGM 压下去，成片听感是配乐一惊一乍。平台侧链的 key
  # 取自 voicebus（对白+旁白），这里照做：直接用包里的对白 wav 另拼一条 key 轨。
  TH=$(jq -r '.audio_contract.ducking.threshold // 0.06' "${OFF}")
  RT=$(jq -r '.audio_contract.ducking.ratio // 6' "${OFF}")
  AT=$(jq -r '.audio_contract.ducking.attack_ms // 20' "${OFF}")
  RL=$(jq -r '.audio_contract.ducking.release_ms // 350' "${OFF}")
  MU=$(jq -r '.audio_contract.ducking.makeup // 1' "${OFF}")
  DUCK_ARGS="threshold=${TH}:ratio=${RT}:attack=${AT}:release=${RL}:makeup=${MU}"

  # 对白 key 轨：每条对白 adelay 到「本镜入点 + 镜内 offset」。
  KEY_IN=(); KEYF=""; KEYL=""; KN=0
  KIDX=$((NBGM + 1))   # 输入 0 是拼好的画面，1..NBGM 是配乐，对白从这里接着排
  for i in $(seq 0 $((NSHOTS - 1))); do
    S=$(jq -c ".shots[${i}]" "${OFF}")
    DF=$(jq -r '.dialogue.file // empty' <<<"${S}")
    [ -z "${DF}" ] && continue
    DABS=$(( $(jq -r '.in_ms' <<<"${S}") + $(jq -r '.dialogue.offset_ms // 0' <<<"${S}") ))
    KEY_IN+=(-i "${PACK}/${DF}")
    KEYF+="[${KIDX}:a]adelay=${DABS}|${DABS}[k${KN}];"
    KEYL+="[k${KN}]"; KN=$((KN + 1)); KIDX=$((KIDX + 1))
  done

  if [ "${KN}" -gt 0 ]; then
    BF+="${KEYF}${KEYL}amix=inputs=${KN}:normalize=0[voicekey];"
    BF+="[bgm][voicekey]sidechaincompress=${DUCK_ARGS}[duck];"
    BF+="[0:a][duck]amix=inputs=2:normalize=0[mix];"
  else
    # 原声（clip）模式：人声烤在画面音轨里，拆不出独立 key —— 只能拿前景总轨当
    # sidechain，音效会误触发避让。要精确避让就得回平台侧终拼。
    BF+="[0:a]asplit=2[fg][sc];"
    BF+="[bgm][sc]sidechaincompress=${DUCK_ARGS}[duck];"
    BF+="[fg][duck]amix=inputs=2:normalize=0[mix];"
  fi
  # 这里**不做 loudnorm**。单 pass loudnorm 是动态归一化：对白间隙里 BGM 成了
  # 唯一能量源，会被逐段上提到目标响度，把混音里刻意压低的 BGM"补偿"回可闻——
  # 平台生产实锤过"BGM 增益 -45 和 -57 出来一样响、调几轮没变化"。响度统一交给
  # 阶段 6 的两 pass 线性母带（全片恒定增益、轨间比例保持）。这里只削峰防削波。
  BF+="[mix]alimiter=limit=${LIMIT}:level=0[amaster]"
  ffmpeg -hide_banner -loglevel error -y -i "${TMP}/cut.mkv" "${BI[@]}" ${KEY_IN[@]+"${KEY_IN[@]}"} \
    -filter_complex "${BF}" -map 0:v -map "[amaster]" \
    -c:v copy -c:a aac -b:a "${AB}" -shortest "${TMP}/mixed.mp4"
else
  ffmpeg -hide_banner -loglevel error -y -i "${TMP}/cut.mkv" \
    -af "alimiter=limit=${LIMIT}:level=0" \
    -c:v copy -c:a aac -b:a "${AB}" "${TMP}/mixed.mp4"
fi

# ── 阶段 5：字幕烧录 ───────────────────────────────────────────────────────
echo "==> [5/6] 字幕"
SRT="${BUILD}/episode.srt"
if [ ! -s "${SRT}" ]; then
  cp "${TMP}/mixed.mp4" "${TMP}/subbed.mp4"
elif [ "${HAS_LIBASS}" = "1" ]; then
  FONTDIR="${PACK}/fonts"
  MARGIN=$(jq -r '.subtitle_contract.margin_v // 80' "${PACK}/manifest.json")
  # 字体必须来自包内 fonts/ —— 你的机器上没有我方字体时会静默退回默认字体，
  # 成片字幕观感与预期不符，且不会报错。
  ffmpeg -hide_banner -loglevel error -y -i "${TMP}/mixed.mp4" \
    -vf "subtitles=${SRT}:fontsdir=${FONTDIR}:force_style='MarginV=${MARGIN}'" \
    -c:v libx264 -b:v "${VB}" -pix_fmt yuv420p -c:a copy "${TMP}/subbed.mp4"
else
  # 降级：软字幕轨。播放器能开关，但不是发布用的烧录版 —— 竖屏平台一律要烧录。
  ffmpeg -hide_banner -loglevel error -y -i "${TMP}/mixed.mp4" -i "${SRT}" \
    -map 0 -map 1 -c copy -c:s mov_text "${TMP}/subbed.mp4"
  echo "  ⚠️ 字幕以软轨输出（本机无 libass），发布前需在带 libass 的机器上重跑烧录。" >&2
fi

# ── 阶段 6：两 pass 线性母带 ────────────────────────────────────────────────
echo "==> [6/6] 响度母带"
# pass1 只测量，pass2 带 measured_* + linear=true 施加**恒定**增益。
# LRA 用 7（交付母带刻意比逐镜混音的 11 收窄动态），与平台终拼一致。
# 测量失败就回退单 pass 动态模式 —— 有瑕疵但不阻塞交付，与平台行为一致。
MASTER_LRA=7
STATS=$(ffmpeg -hide_banner -nostats -i "${TMP}/subbed.mp4" -vn \
  -af "loudnorm=I=${LN_I}:TP=${LN_TP}:LRA=${MASTER_LRA}:print_format=json" \
  -f null /dev/null 2>&1 | sed -n '/^{/,/^}/p')

if [ -n "${STATS}" ] && jq -e '.input_i' >/dev/null 2>&1 <<<"${STATS}"; then
  MI=$(jq -r '.input_i'      <<<"${STATS}")
  MTP=$(jq -r '.input_tp'    <<<"${STATS}")
  MLRA=$(jq -r '.input_lra'  <<<"${STATS}")
  MTH=$(jq -r '.input_thresh'<<<"${STATS}")
  MOFF=$(jq -r '.target_offset' <<<"${STATS}")
  MASTER_AF="loudnorm=I=${LN_I}:TP=${LN_TP}:LRA=${MASTER_LRA}:measured_I=${MI}:measured_TP=${MTP}:measured_LRA=${MLRA}:measured_thresh=${MTH}:offset=${MOFF}:linear=true"
  echo "  测得 I=${MI} TP=${MTP} LRA=${MLRA} → 线性归一到 ${LN_I} LUFS"
else
  MASTER_AF="loudnorm=I=${LN_I}:TP=${LN_TP}:LRA=${MASTER_LRA}"
  echo "  ⚠️ pass1 测量失败，回退单 pass 动态模式（BGM 相对响度可能被上提）" >&2
fi

# +faststart 必须带：本 pass 是最终写盘者，不带会把 moov 甩回文件尾，
# 浏览器流播开播慢/卡顿。
ffmpeg -hide_banner -loglevel error -y -i "${TMP}/subbed.mp4" \
  -c:v copy -af "${MASTER_AF}" -c:a aac -b:a "${AB}" -ar 48000 \
  -movflags +faststart "${OUT}"

# ── 自检 ───────────────────────────────────────────────────────────────────
VD=$(ffprobe -v error -select_streams v:0 -show_entries stream=duration -of csv=p=0 "${OUT}")
AD=$(ffprobe -v error -select_streams a:0 -show_entries stream=duration -of csv=p=0 "${OUT}")
echo "完成: ${OUT}"
echo "  预期 $(ms2s "${TOTAL_MS}")s · 视频 ${VD}s · 音频 ${AD}s"
awk -v v="${VD}" -v a="${AD}" 'BEGIN{ d=v-a; if(d<0)d=-d; if(d>0.5){print "  ⚠️ 音画时长差 " d "s（>0.5s 视为不同步，检查 trim 与 offset 换算）"; exit 1} }'

# ═══════════════════════════════════════════════════════════════════════════
# 加转场：写一份 plan.json 作为第三参数传进来。
#
#   { "transitions": [
#       { "before_shot": 3, "type": "fade" },                  // 用预设规范时长
#       { "before_shot": 7, "type": "flash_white" },           // baked-cut，自动不重叠
#       { "before_shot": 9, "type": "whip_pan", "overlap_ms": 160 }  // 显式覆盖时长
#   ] }
#
# type 接受三种写法：预设 id（fade / flash_white / whip_pan …）、导演语义键
# （match_cut / smash_cut / cross_dissolve …）、或直接给 ffmpeg xfade 名。
# 未知值退回 fade 而不是报错。
#
# 编译器会自动处理：其后所有镜的入点前移、字幕/音效/BGM 同步偏移、重叠超预算钳制、
# 重叠压到对白时告警、下架转场（长叠化卡壳）告警。你不需要手算任何时间。
# ═══════════════════════════════════════════════════════════════════════════
