/**
 * 功能地图 —— 单一真相源。三个消费方都从这里取数：
 *   · index.ts 的 server 级 instructions(客户端 initialize 时拿到、通常注入系统提示);
 *   · get_capabilities_guide 工具(agent 主动查"你们能做什么/客户这种材料该走哪条通道");
 *   · 后端哨兵测试(引导里提到的每个工具名都必须真的注册了,工具改名/下线时测试会红,
 *     引导不会悄悄指向不存在的工具)。
 *
 * 为什么要有它:124 个工具各自的描述都很详细,但 agent 拿到工具清单后并不知道
 * 「客户手上这种材料该走哪条通道」(格式范本 / 分镜表直通道 / 自有素材上传 / 交接包 …),
 * 于是永远只走 set_script → rewrite_script 一条路——客户交的是成品分镜表也被改写成散文。
 * 工具描述回答"这个工具做什么",本文件回答"什么情况下该用哪个"。
 *
 * ★本文件不 import SDK、不联网、不读环境,后端测试可直接 import。
 * ★列表字段(use / tools / run / fix)里每一项以**工具名开头**,括号里写关键参数;
 *   散文字段里的工具名用反引号包住——referencedTools() 靠这两条约定抽名字。
 */
export const GUIDE_VERSION = '2026-09-02'

export interface EntryPoint {
  /** 客户手上有什么(判别条件) */
  customer_has: string
  /** 按序调用的工具;括号里是关键参数/要点 */
  use: string[]
  /** 别走哪条路、为什么 */
  avoid?: string
  /** 一句话补充 */
  note?: string
  /** 全程免费 */
  free?: boolean
  /** instructions 里的一行版流程;不填则按 use 顺序用 → 串起来(有分支/并列的入口必须填,否则读起来像顺序链) */
  flow?: string
}

/** 按客户手上的材料选入口——这是 agent 最常缺的那张表。 */
export const ENTRY_POINTS: EntryPoint[] = [
  {
    customer_has: '小说 / 故事大纲 / 梗概(还不是剧本形态)',
    use: [
      'create_drama(建剧即设好 setting_brief/画幅/video_engine/image_model 等免费地基,别建空壳)',
      'set_script',
      'rewrite_script(auto 路由→创作型改写:AI 铺钩子与情感点)',
      'review_script',
    ],
    note: '改写成功一次后所有修改只走 `edit_rewritten_script` 点改,别重跑 `rewrite_script`(整篇重来,已改好的地方会退回)。',
  },
  {
    customer_has: '已写好的剧本(有场景头 + 对白行结构)',
    use: [
      'set_script',
      'rewrite_script(auto 路由→两步保真:台词逐句机器锁定、AI 不加戏)',
      'get_script(dramaturgy_suggestions 是 AI 识别到但没自动补的剧作缺口,转述给客户定)',
      'review_script',
    ],
    note: '客户要求逐句保留 → `update_project_settings` 设 rewrite_pipeline=two_pass + fidelity_enforce=1。改写仍是必经步:把稿子直接塞进 `edit_rewritten_script` 会 400。',
  },
  {
    customer_has: '想拿到别的 AI 平台自己改写 / 反馈「你们的 AI 改动太大」',
    use: [
      'get_script_format_spec(把 external_prompt + filled_example + markdown 连同原稿一起交给那个平台;务必带 filled_example)',
      'check_script_format(拿回整理稿先自查;errors 清零再往下;免费可反复跑)',
      'adopt_external_script(出口 A:外部稿含制作层标注 → 直接采用为可拍稿,我方 AI 不介入、秒级、不计费)',
      'set_script(出口 B:外部只做了剧情层 → 灌回原稿位,再 rewrite_script 走保真两步补标注)',
    ],
    avoid: '别把外部整理稿塞进 `edit_rewritten_script`(未跑过改写会 400);也别跳过 `check_script_format` 直接灌——格式不合规照样被闸拦,白跑一轮。',
    free: true,
    flow: 'get_script_format_spec → 交给外部平台改 → check_script_format(errors 清零) → 出口A adopt_external_script(含标注·直接采用·免费) 或 出口B set_script + rewrite_script(只有剧情层·平台补标注)',
  },
  {
    customer_has: '做完的成品分镜表(逐镜写了秒数 / 景别 / 运镜;常见于样片、交给电视台或品牌方的表)',
    use: ['import_storyboard_table(不传 content 则读本集原始内容;本集已有分镜要 confirm_replace:true)'],
    avoid: '绝不走 set_script→rewrite_script→generate_storyboards:改写会把秒数/景别/运镜/STYLE/字卡当非剧情内容剥掉(生产实测 8 镜 36 秒被拆成 20 镜 109 秒)。',
    note: '导入后分镜还没有出图/视频提示词,先 `autofill_storyboards` 再出图;`[字卡 9s] 行一 | 行二` 会建成卡镜(成片层直接渲,不出图不出视频)。',
    free: true,
  },
  {
    customer_has: '自有的定妆图 / 场景图 / 道具图 / 镜头图(客户真实素材)',
    use: [
      'upload_image',
      'set_character_portrait(换定妆图后响应里的 stale_frames 就是被旧图污染、要逐镜重生的镜)',
      'upload_scene_image',
      'upload_prop_sheet',
      'upload_shot_frame(只用于客户自有真实素材)',
    ],
    avoid: '要「改某一镜画面」走 `generate_shot_frame`(平台自动带该镜身份锚·场景道具参考·画风锚);别在外部工具画好再 `upload_shot_frame`——外部图没有任何锚,人物/服装/画风必漂。',
    flow: 'upload_image · set_character_portrait · upload_scene_image · upload_prop_sheet · upload_shot_frame(仅客户自有素材;要改画面走 generate_shot_frame)',
  },
  {
    customer_has: '自己的声音样本 / 指定音色',
    use: [
      'clone_voice(需客户对该声音有授权;按音色计费,失败自动退)',
      'speak_with_voice(任意文本试听)',
      'list_voices',
      'set_character_voice(绑到角色;传 voice_id 如 lib:12)',
      'assign_voices',
    ],
    note: '所有项目默认视频原声(use_clip_audio=true,跳过 TTS);要配音把它设 false,并主动告诉客户可切换。',
    flow: 'clone_voice → speak_with_voice(试听) → set_character_voice / assign_voices',
  },
  {
    customer_has: '歌曲 + 歌词(MV)',
    use: [
      'create_drama(project_type=mv)',
      'set_mv_lyrics',
      'generate_mv_story',
      'generate_mv_script',
      'get_mv',
    ],
    note: 'MV 不走标准 `rewrite_script`(会被拦),之后回到 extract_assets → 分镜 → 出图的标准链。',
  },
  {
    customer_has: '产品 / 品牌(广告、品牌微电影)',
    use: [
      'create_drama(project_type=ad 或 brand_film)',
      'add_product',
      'generate_product_sheet',
      'list_products',
      'render_multi_aspect(成片一源多画幅)',
    ],
    note: '广告改写自动走广告改写 agent;文字卡/品牌文案别写成台词(会被念出来)。',
  },
  {
    customer_has: '已生成的镜头 / 成片要改(改台词、裁剪、拆镜、重生某镜、换引擎)',
    use: [
      'scan_dialogue_coverage(先定病因:话没说完/念错/走到别的镜;免费)',
      'scan_intra_shot_cuts(「切太快」先看厂商有没有在单镜内自行硬切;免费)',
      'update_shot(景别/动作/台词/运镜等文本字段;character_ids 全量覆盖)',
      'replace_shot_dialogue',
      'repair_episode_dialogue(换音频不重生视频,按 TTS 费率,比重生便宜几个数量级)',
      'split_shot',
      'trim_shot',
      'recommend_trim_window',
      'regenerate_shot_video',
      'edit_video_shot(就地编辑;get_edit_capabilities 先看当前引擎支持什么)',
      'rerender_episode(改完后免费重拼)',
    ],
    note: '改了台词而视频已存在 → 视频仍念旧词,必须 `regenerate_shot_video`,重拼救不了。',
    flow: 'scan_dialogue_coverage / scan_intra_shot_cuts 先定病因 → update_shot / replace_shot_dialogue / repair_episode_dialogue / split_shot / trim_shot / regenerate_shot_video / edit_video_shot → rerender_episode',
  },
  {
    customer_has: '想自己剪:要逐镜素材包(裸片 / 对白轨 / 音效 / 配乐 / 字幕)',
    use: ['export_handoff_pack', 'get_handoff_toolchain', 'save_handoff_toolchain'],
    note: '与 `compose_episode` 二选一。audio_contract.mode=tts 时裸片没有人声,对白轨单独发——漏掉整集是哑的。',
  },
  {
    customer_has: '多语言发行',
    use: ['translate_subtitles', 'update_project_settings(subtitle_secondary_lang 双语烧录 / subtitle_translation_only 仅译文)'],
  },
]

export interface PipelineStep {
  step: string
  tools: string[]
  billing: '免费' | '文本按 token 后付' | '报价确认后扣点' | '混合'
  gate?: string
  note?: string
}

/** 10 步产线(与 get_pipeline_status 的步序一致;不跳步)。 */
export const PIPELINE: PipelineStep[] = [
  {
    step: '1 建剧与项目设定',
    tools: ['list_project_options', 'create_drama', 'update_project_settings'],
    billing: '免费',
    note: 'setting_brief(世界观/ERA LOCK)、画幅、video_engine、image_model、cinematography_prompt/art_bible/visual_lock 都在这一步定;收费步前服务端会要求 setting_brief≥30 字 + aspect_ratio。',
  },
  {
    step: '2 灌本',
    tools: ['set_script', 'import_storyboard_table(直通道:已有分镜表)', 'adopt_external_script(直通道:外部按范本产出的稿)'],
    billing: '免费',
  },
  {
    step: '3 AI 改写',
    tools: ['rewrite_script', 'get_script', 'edit_rewritten_script'],
    billing: '文本按 token 后付',
    gate: 'review_script(改写稿审查;免费;extract_assets / generate_storyboards 前必过)',
    note: '典型 2~4 分钟;60 秒内查不到不是失败,用 `get_run_status` 判断。',
  },
  {
    step: '4 提取资产(角色/场景/道具)',
    tools: ['extract_assets', 'get_characters', 'get_scenes', 'get_props', 'update_character', 'update_scene', 'update_prop', 'create_prop', 'mark_signature_prop'],
    billing: '文本按 token 后付',
    note: '角色外观唯一真相源 = 人物档案(`update_character` 改;客户确认后 profile_locked=1 锁定);别把角色外观写进 visual_lock/art_bible。',
  },
  {
    step: '5 拆镜(纯文本,先于任何出图)',
    tools: ['quote_storyboards', 'generate_storyboards', 'get_storyboards', 'get_health_report', 'autofill_storyboards', 'enhance_shot_prompts', 'complete_ending_motifs'],
    billing: '报价确认后扣点',
    gate: 'review_storyboards(分镜审查;免费;generate_frames 前必过)',
    note: '每镜 5-7 秒是对 AI 出视频优化的正常时长,别因「镜偏长」重拆;`generate_storyboards` 替换整集分镜,已有分镜需 confirm_replace。',
  },
  {
    step: '6 剧目级一致性资产(分镜后、出图前)',
    tools: [
      'quote_character_portraits', 'generate_portraits_and_sheets(定妆图+设定图,一致性锚)',
      'generate_world_concept(默认必做,仍走报价)', 'generate_motion_templates', 'generate_color_script',
      'generate_art_bible', 'extract_visual_lock', 'extract_setting_brief', 'generate_video_style',
      'quote_scene_images', 'generate_scene_images', 'generate_prop_sheet',
    ],
    billing: '报价确认后扣点',
    note: '分镜后建只给出场角色出图更省;动作模板本就必须分镜后。',
  },
  {
    step: '7 出帧(镜头图)',
    tools: ['run_precheck(免费,揪出必被厂商拒的镜)', 'quote_frames', 'generate_frames', 'quote_shot_frame', 'generate_shot_frame(单镜重生)', 'chain_frames', 'upload_shot_frame'],
    billing: '报价确认后扣点',
    gate: 'review_frames(镜头图审查;免费;generate_videos 前必过)',
    note: '默认只出首帧;尾帧按需(frame_type=last_frame)。pending=还在生成,别重复调 `generate_frames`(重复扣费)。',
  },
  {
    step: '8 出视频',
    tools: ['quote_videos', 'generate_videos', 'get_scene_group_plan', 'generate_scene_groups', 'quote_regenerate_shot_video', 'regenerate_shot_video', 'quote_edit_video_shot', 'edit_video_shot', 'get_edit_capabilities'],
    billing: '报价确认后扣点',
    note: 'video_engine 必须在出视频前定(seedance-2.5 默认 / hailuo-3 降本 / wan3.0 风格化·绝不用于写实真人);切换不回溯已生成镜头。',
  },
  {
    step: '9 音频',
    tools: ['assign_voices', 'generate_tts(仅 use_clip_audio=false)', 'clone_voice', 'generate_bgm', 'get_bgm_status', 'generate_sfx', 'lipsync_shot', 'lipsync_episode', 'get_lipsync_status', 'set_shot_name_card'],
    billing: '混合',
    note: '默认视频原声跳过 TTS 三步(pipeline-status 里显示 not_required,不是没做完)。',
  },
  {
    step: '10 成片与交付',
    tools: ['compose_episode', 'get_final_cut', 'get_export', 'rerender_episode', 'get_deliverables', 'generate_deliverables', 'render_multi_aspect', 'generate_effects', 'generate_transitions', 'generate_episode_poster', 'generate_drama_poster', 'generate_cover', 'translate_subtitles', 'get_pipeline_status'],
    billing: '免费',
    note: '终拼免费(ffmpeg+COS);成片前用 `get_pipeline_status` 确认没有缺镜;配乐晚于成片(bgm_stale)重新 compose 即可。',
  },
]

export const REVIEW_GATES = [
  { after: '改写稿产出', run: 'review_script', before: ['extract_assets', 'generate_storyboards'] },
  { after: '分镜产出', run: 'review_storyboards', before: ['generate_frames'] },
  { after: '镜头图产出', run: 'review_frames', before: ['generate_videos'] },
] as const

export const REVIEW_GATE_RULE =
  '三道闸全部免费、服务端强制(跳过 → 400)。每次审查返回 review_token,把它随下游收费工具一起传;' +
  'findings 逐条原样告诉客户(code=问题类型 · shots=命中镜号 · action=该调哪个工具修),按 action 修完复审再走。' +
  '审查后又改了内容 → token 自动失效,复审一次即可。有 error 时默认拦截;只有客户知情并坚持才带 acknowledge_review:true——不要替客户做这个决定。' +
  '`review_all` 是整集体检、不发 token。'

export interface QaTool { symptom: string; run: string; then: string[] }
export const QA_TOOLS: QaTool[] = [
  { symptom: '话没说完就切 / 台词跑到别的镜上', run: 'scan_dialogue_coverage', then: ['repair_episode_dialogue(首选:换音频不重生,便宜)', 'regenerate_shot_video(特写镜或画面也错时)', 'compose_episode'] },
  { symptom: '切太快 / 一个镜头里画面跳来跳去', run: 'scan_intra_shot_cuts', then: ['update_project_settings(video_engine 改 seedance-2.5 或 hailuo-3)', 'regenerate_shot_video'] },
  { symptom: '动作发生在裁剪窗口之外', run: 'recommend_trim_window', then: ['trim_shot'] },
  { symptom: '画面多出一个人 / 多出一件道具', run: 'get_storyboards(先看该镜实际用的首帧)', then: ['generate_shot_frame(首帧本身就有→重生首帧再重生视频)', 'split_shot(帧干净、片中长出来→拆成 3~5 秒短镜)'] },
  { symptom: '出图 / 出视频前想知道哪些镜会被厂商拒', run: 'run_precheck', then: ['update_shot', 'generate_shot_frame'] },
  { symptom: '整集健康度 / 缺镜 / 进度', run: 'get_pipeline_status', then: ['get_health_report', 'review_all', 'get_storyboards', 'get_jobs', 'get_run_status'] },
  { symptom: '预算 / 余额', run: 'get_budget_status', then: ['get_cost_estimate'] },
]

export const OPTIONAL_BOOSTS = [
  { what: '世界观概念图', tool: 'generate_world_concept', when: '分镜后默认做(提升整剧一致性),仍走报价确认' },
  { what: '美术圣经 / 视觉锁 / 世界观 Brief 抽取', tool: 'generate_art_bible', when: '建剧后;或 `extract_visual_lock` / `extract_setting_brief` 从剧本反推' },
  { what: '动作模板(统一全片运动语言)', tool: 'generate_motion_templates', when: '分镜后、出图前;漏了动作会散乱' },
  { what: '色彩脚本(统一色调)', tool: 'generate_color_script', when: '分镜后、出图前' },
  { what: '场景图(空景基板)', tool: 'generate_scene_images', when: '出镜头图前;先 `quote_scene_images`' },
  { what: '场景组(同场景多镜一次成组出视频)', tool: 'generate_scene_groups', when: '先 `get_scene_group_plan` 看方案' },
  { what: '口型同步', tool: 'lipsync_episode', when: 'TTS 配音项目需要对口型时' },
  { what: '海报 / 封面', tool: 'generate_episode_poster', when: '成片后;`generate_drama_poster` / `generate_cover` 同族' },
  { what: '音效 / 特效 / 转场(本地库匹配)', tool: 'generate_sfx', when: '免费;`generate_effects` / `generate_transitions` 同族' },
  { what: '配乐', tool: 'generate_bgm', when: '按整集情绪弧线生成;终拼自动接管' },
  { what: '字幕翻译', tool: 'translate_subtitles', when: '出海;双语烧录在项目设定里开' },
]

export const BILLING = {
  prepaid: '预付费、永不透支。余额不足返回 402(带 needed),停下来让客户充值,绝不循环重试。',
  quote_flow:
    '大额步(定妆图 / 分镜 / 出帧 / 出视频 / 场景图)一律 quote_* → 把 estimated_points **原样**告诉客户 → 客户明确同意 → generate_*(带 quote_id)。' +
    'quote_id 一次性、约 15 分钟过期;绝不擅自确认,视频报价可能上万点。',
  pay_as_you_go: '文本步(改写 / 提取 / 自动填充 / 增强提示词)按 token 后付,无需报价但要事先告知。',
  free_families: [
    '所有 get_* / list_* / scan_* / review_* / check_* / recommend_* / get_capabilities_guide',
    'compose_episode / rerender_episode / render_multi_aspect / generate_sfx / generate_effects / generate_transitions',
    'import_storyboard_table / adopt_external_script / get_script_format_spec / check_script_format',
    'update_* / edit_rewritten_script / split_shot / trim_shot / set_character_portrait / upload_*',
  ],
  tools: ['get_budget_status', 'get_cost_estimate'],
}

export interface CommonRequest { customer_says: string; do: string }
export const COMMON_REQUESTS: CommonRequest[] = [
  { customer_says: '你们能做什么 / 我该从哪开始', do: '先问客户手上有什么材料,对照 entry_points 选通道;建剧前 `list_project_options` 把项目类型/画幅/分辨率/引擎给客户挑。' },
  { customer_says: 'AI 把我的剧本改偏了 / 改动太大', do: '① 确认完整原稿已进 `set_script`;② `update_project_settings` 设 rewrite_pipeline=two_pass 后重跑 `rewrite_script`;③ 客户确认外观后 `update_character` profile_locked=1。客户想自己掌控 → 走格式范本三步(`get_script_format_spec` → 外部改 → `check_script_format`)。' },
  { customer_says: '我有分镜表了,直接出片', do: '`import_storyboard_table`,不要走改写;导入后 `autofill_storyboards` 补提示词再 `review_storyboards`。' },
  { customer_says: '换了定妆图 / 换脸后镜头没变', do: '`set_character_portrait` 响应里的 stale_frames 逐镜 `generate_shot_frame`,再重生视频。' },
  { customer_says: '图片一直没出来', do: '`get_storyboards` 看 frame_status:pending=在生成(每张几十秒到数分钟、整集十几分钟),别重复调 `generate_frames`;failed 才是失败,读 fail_reason / fail_hint。' },
  { customer_says: '预算多少 / 怎么更便宜', do: '各步 quote_* + `get_cost_estimate`;降本:hailuo-3(约 1/3)或 wan3.0(约 4 折,仅风格化/空镜/产品镜,写实真人绝不选)+ 草稿期低分辨率。' },
  { customer_says: '成片里话没说完 / 切太快', do: '先 `scan_dialogue_coverage` / `scan_intra_shot_cuts` 定病因,再按 qa_tools 的 then 修;别默认去加长镜头。' },
  { customer_says: '我想自己剪', do: '`export_handoff_pack` + `get_handoff_toolchain`,不走 `compose_episode`。' },
  { customer_says: '要配音 / 不要视频原声', do: '`update_project_settings` use_clip_audio=false → `assign_voices` → `generate_tts` → `compose_episode`。' },
]

export const HOW_TO_READ =
  '先按 entry_points 判客户手上的材料该走哪条通道(这是最常被跳过的一步),再按 pipeline 顺序推进、每道 review_gates 必过;' +
  '收费步按 billing.quote_flow 报价确认;遇到质量投诉按 qa_tools 的 symptom 选检测工具先定病因。'

export function buildGuide() {
  return {
    version: GUIDE_VERSION,
    how_to_read: HOW_TO_READ,
    entry_points: ENTRY_POINTS,
    pipeline: PIPELINE,
    review_gates: { rule: REVIEW_GATE_RULE, gates: REVIEW_GATES },
    qa_tools: QA_TOOLS,
    optional_boosts: OPTIONAL_BOOSTS,
    billing: BILLING,
    common_requests: COMMON_REQUESTS,
  }
}
export type GuideSection = Exclude<keyof ReturnType<typeof buildGuide>, 'version' | 'how_to_read'>
export const GUIDE_SECTIONS = ['entry_points', 'pipeline', 'review_gates', 'qa_tools', 'optional_boosts', 'billing', 'common_requests'] as const

const head = (s: string) => /^[a-z][a-z0-9_]*/.exec(s.trim())?.[0] ?? null
const inProse = (s: string | undefined) => [...(s ?? '').matchAll(/`([a-z][a-z0-9_]*)`/g)].map((m) => m[1])

/** 引导里引用到的全部工具名(去重)——哨兵测试用:每一个都必须真的注册了。 */
export function referencedTools(): string[] {
  const out = new Set<string>()
  const add = (v: string | null) => { if (v) out.add(v) }
  for (const e of ENTRY_POINTS) { e.use.forEach((u) => add(head(u))); [...inProse(e.avoid), ...inProse(e.note)].forEach(add) }
  for (const p of PIPELINE) { p.tools.forEach((t) => add(head(t))); if (p.gate) add(head(p.gate)); inProse(p.note).forEach(add) }
  for (const g of REVIEW_GATES) { add(g.run); g.before.forEach(add) }
  inProse(REVIEW_GATE_RULE).forEach(add)
  for (const q of QA_TOOLS) { add(head(q.run)); q.then.forEach((t) => add(head(t))) }
  for (const b of OPTIONAL_BOOSTS) { add(b.tool); inProse(b.when).forEach(add) }
  BILLING.tools.forEach(add)
  for (const c of COMMON_REQUESTS) inProse(c.do).forEach(add)
  return [...out].sort()
}

/**
 * server 级 instructions:客户端 initialize 时拿到,多数客户端注入系统提示。
 * 要短——只放入口决策树、产线顺序、硬闸与计费纪律;细节让 agent 调 get_capabilities_guide。
 */
export function buildInstructions(): string {
  const entry = ENTRY_POINTS.map((e) => `· ${e.customer_has} → ${e.flow ?? e.use.map((u) => head(u)).filter(Boolean).join(' → ')}`).join('\n')
  return [
    'StarReel = 预付费 AI 短剧产线(剧本 → AI 改写 → 资产 → 分镜 → 镜头图 → 视频 → 音频 → 成片 .mp4),120+ 个工具,全部走本服务器。',
    '',
    '★第一步永远是判「客户手上有什么材料」——它决定入口,选错入口的返工都是真扣费(全表与要点:get_capabilities_guide):',
    entry,
    '',
    '产线顺序(不跳步):create_drama(建剧即设好 setting_brief/画幅/video_engine/image_model/一致性锚,全免费) → set_script → rewrite_script → ★review_script → extract_assets → quote/generate_storyboards → ★review_storyboards → 定妆图+设定图 / 世界观图 / 动作模板 / 色彩脚本 → run_precheck → quote/generate_frames → ★review_frames → quote/generate_videos → 音频 → compose_episode → get_final_cut。用 get_pipeline_status 查进度。',
    '三道免费硬闸(跳过 → 400):review_script(extract_assets/分镜前)· review_storyboards(出图前)· review_frames(出视频前);review_token 随下游收费工具传,findings 逐条原样告诉客户。',
    '计费纪律:预付费不透支;大额步 quote_* → 把 estimated_points 原样告诉客户 → 客户同意后 generate_*(quote_id),绝不擅自确认;文本步按 token 后付;402 就停下让客户充值,别重试。',
    '长任务异步:generate_* 立即返回,用 get_pipeline_status / get_storyboards / get_run_status 轮询;图片 pending = 还在生成,别重复调(重复扣费)。',
    '改写成功后只 edit_rewritten_script 点改,别重跑 rewrite_script;角色外观唯一真相源是人物档案(update_character),别写进 visual_lock/art_bible。',
    '不确定该用哪个工具、客户问「你们能做什么」→ 先调 get_capabilities_guide(免费、本地、不联网)。',
  ].join('\n')
}
