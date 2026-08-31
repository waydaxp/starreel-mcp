/**
 * 短剧编排产线工具集(P2)。对接网关 /v1/produce/*(门面),把
 * 「建剧 → 灌本 → 拆镜 → 出帧 → 出视频 → 成片」整条产线包成 agent 可调的工具。
 *
 * 设计铁律 —— 批量报价确认(人在环):
 *   每个花钱阶段拆成 quote_* + generate_*。agent **必须**先调 quote_*,把预估点数
 *   原样告诉用户,等用户确认后才调 generate_*(带 quote_id)。绝不擅自确认——报价可能
 *   是上万点的视频。generate_* 是**批量**执行(整集一次),不是一图一图,别循环逐条确认。
 *
 * 长任务(拆镜/出帧/出视频/成片)都是后台异步:generate_* 立即返回 status:'generating',
 * 用 get_storyboards / get_episode_status 轮询到完成。下载链接只发我方 COS 链接。
 */
import { z } from 'zod'
import { readFileSync, writeFileSync, chmodSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import type { StarReelClient } from '../client.js'
import { assertSafeToolchainDir, TOOLCHAIN_FILENAMES } from '../path-guard.js'

const TOOLCHAIN_USAGE = [
  '1. 三个脚本放同一目录(assemble.sh 需可执行位)。',
  '2. 把 export_handoff_pack 的返回体存成 manifest.json。',
  '3. python3 fetch_pack.py manifest.json -o ./pack   # 下载素材 + 内联字幕落成逐镜 SRT + 改写成本地路径',
  '4. python3 compile_timeline.py ./pack [--transitions plan.json]   # 展开时间轴',
  '5. ./assemble.sh ./pack out.mp4 [plan.json]   # 装配成片',
]
const TOOLCHAIN_NOTE =
  'assemble.sh 会先自检 ffmpeg 是否带 libass;不带则字幕以软字幕轨输出而非烧录(竖屏发布必须烧录)。' +
  '包里若带 render_target.color_lut,fetch_pack.py 会把调色查找表一并下载,assemble.sh 自动施加——' +
  '不施加的话你的成片与平台成片会有色差。'

/**
 * 随包发布的装配工具链目录。本文件编译后在 dist/tools/produce.js，
 * assets/ 在包根，所以要上两级 —— 少一级会静默解析到 dist/assets（不存在），
 * 而 get_handoff_toolchain 里 catch 掉读取异常，坏结果不会崩、只会悄悄发给第三方。
 * release-check 里有一条闸钉住这个路径。
 */
export const HANDOFF_ASSETS = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'assets', 'handoff')

function jsonResult(data: unknown) {
  return { content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }] }
}

const CONFIRM_HINT =
  '⚠️ 批量报价确认流程:先调对应的 quote_* 工具,把返回的 estimated_points 原样告诉用户,' +
  '用户明确同意后,才用返回的 quote_id 调本工具。不要擅自确认。'

// ★分阶段审查硬闸(v0.9.1076):三个大额收费步必须先过本层审查才放行。
// 设计意图=防「盲推产废片」:改写稿的问题会被资产/分镜/出图逐层放大,等成片才发现
// 就是整集重来、且每次重来都真扣厂商的钱。审查全部免费,拦下来不花一分钱。
const REVIEW_GATE_HINT = (tool: string, layer: string) =>
  `\n★【${layer}审查硬闸·免费】本步前必须先调 ${tool}:把返回的 findings 逐条原样告诉客户` +
  `(每条带 code=问题类型、shots=命中镜号、action=该调哪个工具修),再把 review_token 传进本工具。` +
  `未审查会被 400 拒。审查后又改了内容 → token 自动失效,复审一次即可(仍免费)。` +
  `有 error 时默认拦截;客户知情并坚持照现状继续,才带 acknowledge_review:true——` +
  `带病推进大概率产出废片且照常扣费,不要替客户做这个决定。`

/** 三个被闸的收费工具共用的参数(zod 形状,展开进各自 schema)。 */
const REVIEW_ARGS = {
  review_token: z.string().optional().describe('★来自本层 review_* 工具的凭据(受闸项目必填;缺了会 400 并告诉你该调哪个审查工具)'),
  acknowledge_review: z.boolean().optional().describe('审查有 error 时,客户已知情并明确要求照现状继续才传 true(默认拦截)'),
}

// 完整工作流顺序(照 get_pipeline_status 的 10 步真相走,不要跳步):
//   create_drama → set_script(原始) → rewrite_script(AI改写) → [get_script/edit_rewritten_script 审改]
//   → extract_assets(角色/场景/道具) → quote/generate_storyboards(先分镜·纯文本拆镜)
//   → generate_character_portraits(定妆图·一致性关键·分镜后建只给出场角色更省) → quote/generate_frames → quote/generate_videos
//   → compose_episode → get_final_cut / get_export
// 项目设定随时可 update_project_settings;剧目级资产(色彩脚本/动作模板/世界观图/美术圣经)可选增强。
const WORKFLOW_HINT =
  '★三档执行策略(别把三档混着问客户):' +
  '①【基础项目设定·免费·必做地基·建剧即设好,别建空壳】project_type/setting_brief(世界观·ERA LOCK)/' +
  'ethnicity(族裔)/画幅分辨率,以及一致性锚 cinematography_prompt(摄影DNA)·art_bible(美术圣经)·visual_lock(视觉锁定)——' +
  '全免费,是驱动全链一致性的地基;不设好,后续所有生成都跑偏、返工重花钱。用 create_drama/update_project_settings 直接设。' +
  '★visual_lock/art_bible 只写画面级/世界级锁(镜头语言·环境·美术基调·禁入元素),**绝不为具体角色钉服装/发型/外观细节**——' +
  '角色外观的唯一真相源是 extract_assets 产出的人物档案(要改走 update_character);两处都写必然互相矛盾,' +
  '定妆图跟档案、设定图跟视觉锁,一致性闸按定妆图拒收 → 设定图/镜头帧**结构性连拒**,重掷多少次都过不了、纯白花钱。' +
  '★★【逐环节审查协议·全部免费·这是防废片的主线,不是可选项】每个环节产出后先审查、把结论原样告诉客户,再进下一步。' +
  '**三道硬闸(不过会被 400 拒)**:①改写稿产出后 → review_script(在 extract_assets / generate_storyboards 之前);' +
  '②分镜产出后 → review_storyboards(在 generate_frames 之前);③镜头图片产出后 → review_frames(在 generate_videos 之前)。' +
  '每次审查返回 review_token,把它随下游收费工具一起传;findings 逐条讲给客户(code=问题类型·shots=命中镜号·action=该调哪个工具修),' +
  '按 action 修完后**复审**再走。审查后又改了内容 → token 自动失效,复审一次即可(免费)。' +
  '有 error 时默认拦截,只有客户明确知情并坚持才带 acknowledge_review:true——别替客户做这个决定。' +
  '**软引导(不阻断但强烈建议,同样免费)**:出图/出视频前跑 run_precheck(揪出必被厂商拒的镜,防白花钱);' +
  '分镜后跑 get_health_report;定妆图出完用 get_characters 核对每个出场角色都有 image/sheet;' +
  '出帧后用 get_storyboards 看 frame_status 与 fail_reason/fail_hint(failed 的镜先修再往下,别带着废帧出视频);' +
  '出视频后同样看 video_status;成片前用 get_pipeline_status 确认没有缺镜。' +
  '★**禁止一路 generate 到底**:不审查就连推的做法,问题会在每一层被放大,最后整集废掉重来——' +
  '而重来的每一次出图/出视频都是真扣费。审查全部免费,拦下来一分钱不花。' +
  '②【产线主干·按序不跳步·★先分镜再建资产】set_script→rewrite_script→★review_script→extract_assets→storyboards(先分镜·纯文本拆镜)→★review_storyboards→' +
  '★剧本纪律(端点强制,绕不过):原始素材(梗概/大纲/成品稿都算)一律放 set_script,**必须经 rewrite_script 产出 AI 改写稿**——' +
  '把自己写好的剧本直接贴进 edit_rewritten_script 绕过改写会被 400 拒(没有改写稿就没有可改的对象),extract_assets 同样要求基于改写稿。' +
  '改写后的所有修改按 AI 产物的结构化格式做:改稿 edit_rewritten_script(润色/纠正)、人物档案 update_character、分镜 update_shot/replace_shot_dialogue——' +
  '别回头整篇替换剧本或在设定字段里另写一套,两套真相源打架是一致性事故的头号根源。' +
  '★★**改写成功一次后就别再重跑 rewrite_script**:它是从原稿整篇重来,当前稿的所有修正全丢,' +
  '且新版不保证保留旧版已改好的地方(三版实测会来回摆)。要修就 edit_rewritten_script 点改' +
  '(get_script 取全文 → 只改那几场、其余逐字照抄 → 提交整篇),免费秒级、结果确定;' +
  '误重跑用 get_script(include_previous=1) 回捞上一版。' +
  'generate_portraits_and_sheets(定妆图+设定图·分镜后建只给出场角色出图更省)→assign_voices(分配音色)→frames→★review_frames→videos→generate_tts→compose;' +
  '★别先建角色形象/道具设定图/动作模板再分镜——分镜是纯文本步、不依赖任何图;资产在分镜后建更省更准(动作模板本就必须分镜后)。收费步照现有 quote 报价确认流程。' +
  '广告另需 add_product+generate_product_sheet;MV 走 set_mv_lyrics→generate_mv_story→generate_mv_script。' +
  '★世界观概念图=默认必做(提升整剧一致性、很多第三方平台漏做这步):分镜后默认调 generate_world_concept,' +
  '仍走报价确认流程(告知客户预估点数、确认再扣)——不静默扣费、也别跳过。' +
  '★分镜后的剧目级资产别漏——尤其 generate_motion_templates(动作模板:从分镜抽取统一全片运动语言,漏了动作会散乱)' +
  '与 generate_color_script(色彩脚本:统一色调);分镜后、出图前一并做,仍走报价确认。' +
  '★场景 Bible(每场景详细设定)顺序在**场景图片出图之后**——据出好的场景图完善(MCP 暂无此工具、在官网做);' +
  '别在出场景图前做场景 Bible。' +
  '★音频默认用视频原声(use_clip_audio 默认开、跳过 TTS 直接用 AI 视频自带声):' +
  '建剧/改设定时 AI 应主动告知客户「默认用视频原声,如需 TTS 配音把 use_clip_audio 设 false」,让客户选。' +
  '★图片模型默认香蕉2(Nano Banana 2 = gemini-3.1-flash-image·整剧统一画风):create_drama/update_project_settings 的 image_model 设,不传即默认香蕉2;' +
  '可选 gemini-3-pro-image(香蕉Pro·更精细·175点)/gemini-3.1-flash-lite-image(香蕉2 Lite·便宜·31点)/doubao-seedream-5-0-260128(Seedream5.0)/gpt-image-2(ChatGPT Image2);generate_frames 可临时覆盖某次。' +
  '★视频引擎四选一(drama级·AI 建剧时必须主动按剧选型引导并给价差让客户定):' +
  '【选型决策树】①写实真人剧→seedance-2.5(默认·指令遵循/人脸细节最强·720p 212点/秒),预算敏感可 hailuo-3(约1/3成本70点/秒·强保真编辑·但单镜约6分钟);' +
  '②风格化/动画/3D卡通剧·空镜·产品镜→wan3.0(约4折84点/秒·最长30秒·最短2秒计费·单镜约2分钟),赶交付用 wan3.0-prime(126点/秒·约1分钟);' +
  '③★写实真人剧绝不选 wan3.0/prime——WAN 输出侧真人脸审核在 720p+ 一致拒、重试救不回;' +
  '④★★叙事剧(有对白、讲连贯故事、镜头节奏要稳的)慎选 wan3.0/prime:WAN 会在**单个分镜片内自行换机位硬切**' +
  '(实测 11/12 镜有镜内跳切,对照 seedance-2.5 仅 1/6、hailuo-3 为 0/5),成片观感是「一个镜头里画面跳来跳去、切太快」;' +
  '这是厂商指令遵循弱、提示词层拦不住(我方负向约束早已在其中且实测无效),事后只能换引擎重生。' +
  'WAN 适合镜头本就短平快的风格化/空镜/产品镜;要稳定单镜叙事请选 seedance-2.5 或 hailuo-3。生成后可用 scan_intra_shot_cuts 核查;' +
  '⑤★镜长控制(所有引擎通用,WAN 上尤其明显):单镜保持 3~5 秒。镜头越长模型自由发挥空间越大——' +
  '实测一个 16 秒单镜(邻镜都是 3~5 秒)在片内换了 4 次场景、人物中途消失 4 秒后又从画面边缘长出来,' +
  '客户看到的就是「凭空多出一个人」。要长表演请拆成多个短镜再靠帧链衔接,别写 15 秒以上的单镜;' +
  '【分辨率决策】草稿/迭代期:WAN 剧 480p(42点/秒最省)、其余 720p;成片交付:seedance 剧 720p(高清档停售)、hailuo-3 剧 1080p(=2K·112点/秒)、WAN 剧 1080p(168点/秒);hailuo-3 无独立 480p 档(选了也按 768P 计费);' +
  'create_drama/update_project_settings 的 video_engine/video_resolution 设,★都必须在出视频前定——切换不回溯已生成镜头,同剧混用会画风/身份漂移。' +
  '★图片生成慢≠失败:每张几十秒~数分钟、整集可能十几分钟,轮询 get_storyboards 看 frame_status——pending=还在生成(耐心等、别重复调 generate_frames 白花钱)、ready=完成、failed=才是真失败。' +
  '★改某一镜画面 / 换定妆图后要让新图生效,走**单镜重生 generate_shot_frame**(平台自动带该镜身份锚·场景道具参考·画风锚,保全片一致);' +
  'generate_frames 只批量补「缺帧」的镜、已有首帧的镜跳过(正常、不是"拒绝"),尾帧用 frame_type=last_frame 可批量补。换定妆图(set_character_portrait)后响应里的 stale_frames 就是被旧图污染、需逐镜重生的镜。' +
  '★绝不用外部工具自制首尾帧再 upload_shot_frame 来"改画面"——外部图无身份锚/画风锚,人物·服装·画风必漂,那才是废片根源;upload_shot_frame 只用于客户自有真实素材。' +
  '③【可选增强·AI 主动提示客户·报价确认才做】美术圣经生成/视觉锁抽取/色彩脚本/动作模板/场景图/场景组/口型/海报/音效/配乐/字幕翻译——' +
  '这些提升一致性/质量、大多收费。★AI 应主动告知客户这些可做并给报价,客户确认才跑;既不默默跳过、也不擅自扣费。' +
  '★两条锁定纪律:①**画幅比例**在 create_drama 即定、drama 级锁定,之后所有出图/出视频/成片都用它、**别中途改**' +
  '(改了已生成内容画幅会不一致、漂移);不设默认 9:16。②**拆镜每镜 5-7 秒是对 AI 出视频优化的正常时长**,' +
  '别因「镜偏长」误判就重拆——generate_storyboards 会**替换整集所有分镜**、已出图白费,已有分镜后端会拦、需 confirm_replace。' +
  '★改写保真(默认 auto 智能路由):set_script 的原稿**本身已是剧本形态**(场景头/对白行结构)时,rewrite_script 自动走两步保真——' +
  '客户台词逐句由机器闸锁定(丢一句即内部拒收重做)、AI 绝不加戏;剧作缺口(钩子/情感锚点)不自动补,写进 get_script 返回的 dramaturgy_suggestions 由客户决定采纳。' +
  '原稿是小说/大纲则自动走创作型改写(AI 铺钩子造情感点),两种客户各得其所、无需手动切换。' +
  '要覆盖默认用 update_project_settings 的 rewrite_pipeline(auto/two_pass/single_forced)与 fidelity_enforce(1=保真硬闸)。' +
  '客户说「AI 把我的剧本改偏了」时的处置:①确认完整原稿已进 set_script;②rewrite_pipeline 设 two_pass 强制保真后重跑 rewrite_script;' +
  '③客户确认角色外观后用 update_character 的 profile_locked=1 锁定档案,防后续提取覆盖外貌导致定妆图换脸。' +
  '用 get_pipeline_status 查进度(按项目类型返回专属步骤)。'

const ETHNICITY_CODES = [
  'east_asian', 'southeast_asian', 'south_asian', 'central_asian',
  'caucasian', 'middle_eastern', 'african', 'latin_american',
  'native_american', 'aboriginal_australian', 'mixed', 'custom',
] as const

// 画幅/分辨率的可选值 —— create_drama 与 update_project_settings **共用同一源**,防两处漂移。
// 与后端发现接口 produce-options.ts 的 ASPECT_RATIO_OPTIONS / VIDEO_RESOLUTION_OPTIONS 键集一致
// (video_resolution 与后端 VIDEO_RES_WHITELIST 钉死;aspect_ratio 后端柔性,这里给同一策展集)。
// 帧类型(与后端 produce-facade.parseFrameParam 同一枚举):整集/单镜出帧共用。
const FRAME_TYPE_ARG = z.enum(['first_frame', 'last_frame', 'both'])

const ASPECT_RATIOS = ['9:16', '16:9', '1:1', '4:5', '4:3', '21:9'] as const
const VIDEO_RESOLUTIONS = ['480p', '720p', '1080p', '4k'] as const
// 剧级视频引擎(与后端 video-engine-policy 白名单同源;短 id,后端归一化)。
const VIDEO_ENGINES = ['seedance-2.5', 'hailuo-3', 'wan3.0', 'wan3.0-prime'] as const

// 「项目设定页」通用视觉/音频/字幕/转场设定 —— create_drama 与 update_project_settings 共用。
// 后端内部 PUT /dramas 已接受写库,facade 白名单 Wave3 已放行(produce-create-fields.ts)。
// 不含内部产线/成本开关(strict_mode/best_of_n/shoppable/budget_points 等,需产品决策)。
const PROJECT_SETTINGS_FIELDS = {
  // drama 级图片模型(整剧统一画风):默认 Nano Banana 2(香蕉2)
  image_model: z.string().optional().describe('图片模型(★drama级·整剧统一画风·默认香蕉2 Nano Banana 2)。可选:' +
    'gemini-3.1-flash-image(香蕉2·默认·71点)/gemini-3-pro-image(香蕉Pro·精细·175点)/gemini-3.1-flash-lite-image(香蕉2 Lite·31点)/' +
    'doubao-seedream-5-0-260128(Seedream 5.0)/gpt-image-2(ChatGPT Image 2)。建剧即定、整剧统一;generate_frames 可临时覆盖某次出图'),
  // drama 级视频引擎(整剧统一,单镜/批量/场景组/重生全走它)
  video_engine: z.enum(VIDEO_ENGINES).optional().describe('视频引擎(★drama级·整剧统一·AI必须按剧选型主动引导:写实真人剧→seedance-2.5 或降本 hailuo-3;风格化/动画/3D卡通/空镜/产品镜→wan3.0(赶交付 wan3.0-prime);写实真人剧绝不选 wan——720p+ 真人脸被厂商审核一致拒):' +
    'seedance-2.5(默认·全能力:帧链/场景组/就地编辑/延长/参考图锚·720p约212点/秒) / ' +
    'hailuo-3(MiniMax H3:约1/3成本 720p 70点/秒·原生对白与音效·支持2K·单镜约6分钟·支持就地编辑(强保真)与成片续写·关键帧组/时间戳区间暂不可用;编辑/续写输入视频另按秒计费) / ' +
    'wan3.0(WAN 3.0:约4折成本 720p 84点/秒·原生对白与音效·支持1080P·单次最长30秒·最短2秒计费·支持就地编辑(强语义)与成片续写·关键帧组/时间戳区间暂不可用;★写实真人720p+可能被厂商审核拒绝,风格化/动画剧适用;★★会在单个分镜片内自行换机位硬切(实测11/12镜)→叙事剧慎用,详见选型决策树④) / ' +
    'wan3.0-prime(WAN 3.0 高速版:能力同wan3.0·出片约2×·费率1.5×=720p 126点/秒;镜内自剪同 wan3.0)。' +
    '★必须在出视频**前**设置——切换不回溯已生成的镜头,同剧混用引擎会有画风/身份漂移风险'),
  // 整剧视觉一致性锚(注入所有出图/视频 prompt,决定跨镜一致)
  cinematography_prompt: z.string().optional().describe('摄影DNA:镜头/镜片/光圈/调色一揽子,注入所有出图/视频prompt,整剧镜头一致。' +
    '★★写**单镜**摄影规格,不要写整部剧的镜头序列:本字段会被原样注入**每一个分镜**,' +
    '写成「航拍大远景开场→中景→跟摇→推近→剪影收尾」这类序列 = 在要求厂商把 5 段机位塞进每个 3 秒镜。' +
    '正确写法举例:「浅景深长焦,黄金时刻光线与体积光,逆光轮廓,冷暖对比」——只描述镜片/光线/调色等全片统一的摄影属性'),
  art_bible: z.string().optional().describe('美术圣经:色调/材质/气质,注入所有生图prompt,统一视觉风格'),
  visual_lock: z.string().optional().describe('视觉锁定:民族外貌/服装约束/禁止元素,最高优先级、无条件注入所有生图prompt'),
  video_style_prompt: z.string().optional().describe('视频风格锁定·正向风格词(前置注入,描述渲染质感/美术)'),
  video_negative_prompt: z.string().optional().describe('视频风格锁定·负向排除词(末尾追加,防风格跳变)'),
  motifs: z.string().optional().describe('视觉母题:反复出现的物件/颜色,逗号分隔(每个应≥3镜复现)'),
  theme: z.string().optional().describe('主题(一句话核心冲突·防跑题);★≠theme_statement,这是UI「主题」框对应的列'),
  // 音频(BGM 源/开关/音量 + 用视频原声)
  bgm_enabled: z.boolean().optional().describe('BGM总开关:false=终拼不混任何BGM,保留视频原声'),
  bgm_source: z.enum(['own', 'clip']).optional().describe("BGM来源:own=自有BGM流水线(默认,抑制裸片BGM);clip=保留视频原生BGM、终拼不叠加"),
  bgm_volume_preset: z.enum(['off', 'low', 'auto', 'high']).optional().describe('BGM音量档:off静音/low轻(-28dB)/auto自适应(默认,静段可闻·对白不压麦)/high强'),
  bgm_volume_db: z.number().optional().describe('自定义BGM音量(dB,负值),覆盖预设档、关自适应'),
  use_clip_audio: z.boolean().optional().describe('用视频原声(★默认开):true/不传=跳过TTS配音直接用视频自带声;false=改回TTS配音。所有类型默认视频原声,建剧时应主动告知客户可切换配音(★直接改成片音频)'),
  // 字幕(烧录/双语/仅译文/位置/边距/动效)
  show_subtitles: z.boolean().optional().describe('字幕烧录总开关:false=不烧字幕轨'),
  subtitle_secondary_lang: z.string().optional().describe('双语字幕第二语言(如 en/ja);设了即双语(需先字幕同步翻译该语言)'),
  subtitle_translation_only: z.boolean().optional().describe('仅显示译文(不显原文)'),
  subtitle_position: z.enum(['bottom', 'top']).optional().describe('字幕位置(默认 bottom)'),
  subtitle_margin_v: z.number().optional().describe('字幕边距 MarginV 像素(与画面边缘距离,默认 80)'),
  subtitle_animation: z.string().optional().describe('字幕动效:fade(默认)/bounce弹跳/typewriter打字机/highlight高亮'),
  // 转场 + 多画幅裁切 + 片头尾卡
  default_transition: z.string().optional().describe('镜头间转场预设(默认 fade;21种+智能)'),
  default_transition_ms: z.number().optional().describe('转场时长 ms(默认 250;短剧 200-400 体感佳)'),
  reframe_mode: z.string().optional().describe('一源多画幅裁切策略'),
  reframe_anchor: z.string().optional().describe('多画幅裁切锚点'),
  cover_card_default: z.string().optional().describe('片头封面卡默认'),
  poster_card_default: z.string().optional().describe('片尾海报卡默认'),
}

/** 把友好 ethnicity 枚举 + note 组装成后端认的结构化族裔锁 { code, note? }。 */
function buildEthnicityLock(ethnicity?: string, note?: string): Record<string, unknown> | undefined {
  if (!ethnicity) return undefined
  return ethnicity === 'custom' ? { code: 'custom', note: note ?? '' } : { code: ethnicity }
}

export function registerProduceTools(server: McpServer, client: StarReelClient) {
  // ---------- 建剧前:列可选项 ----------
  server.tool(
    'list_project_options',
    '列出建剧的全部可选项:项目类型(短剧/广告/MV/品牌片)、画幅比例、视频分辨率、视频引擎(Seedance 2.5/MiniMax H3,带价差与能力差)(带中英标签+说明+默认值)。' +
      '建剧前先调它,把选项给用户挑,再照 key 传给 create_drama。免费。',
    {},
    async () => jsonResult(await client.produceGet('/project-options')),
  )

  // ---------- 建剧 ----------
  // 参数=「项目设定 / 新建项目」页对外能设的全部通用字段(不含内部产线开关)。
  // 尤其 setting_brief(世界观 Brief)与 ethnicity:它们是全链 ERA LOCK / 族裔单一真相源,
  // 建剧时设好,下游剧本改写·分镜·所有出图都据它约束——不设则按剧本语言自动推断(旧行为)。
  server.tool(
    'create_drama',
    '新建一部短剧(剧壳)。★强烈建议建剧时一并设好基础项目设定——project_type/setting_brief(世界观·ERA LOCK)/' +
      'ethnicity(族裔)/画幅分辨率,以及一致性锚(cinematography_prompt/art_bible/visual_lock)。这些全免费、' +
      '是驱动全链一致性的地基;只传 title 建空壳会让后续所有生成跑偏、返工重花钱。' +
      '按 total_episodes 自动建 N 空集,返回 drama_id 与各集 episode_id。免费。',
    {
      title: z.string().describe('剧名'),
      total_episodes: z.number().int().min(1).max(200).optional().describe('集数(默认 1),自动建 N 个空集'),
      genre: z.string().optional().describe('题材,如 都市/悬疑/古装'),
      style: z.string().optional().describe('风格描述'),
      description: z.string().optional(),
      aspect_ratio: z.enum(ASPECT_RATIOS).optional().describe('画幅比例(默认 9:16 竖屏短剧)。★drama级锁定:建剧即定、之后所有出图/出视频/成片都用它,别中途改(改了已生成内容画幅不一致、漂移)'),
      video_resolution: z.enum(VIDEO_RESOLUTIONS).optional().describe('视频分辨率(默认 720p;成本随分辨率上升)。按引擎选:' +
        'seedance-2.5 在售 480p/720p(高清档停售);hailuo-3 选 720p(=768P 70点/秒)或 1080p(=2K 112点/秒),无独立 480p 档;' +
        'wan3.0/prime 三档全售(42/84/168,prime 63/126/252 点/秒)。草稿迭代用低档,成片交付才上高清'),
      setting_brief: z
        .string()
        .optional()
        .describe(
          '世界观 Brief:一段话锁定语言/文化/时代/地点,作为 AI 强制约束(ERA LOCK),' +
            '影响剧本改写·分镜·所有出图。不设则按剧本语言与文化自动推断。',
        ),
      ethnicity: z.enum(ETHNICITY_CODES).optional()
        .describe('全剧角色族裔锁(单一真相源)。不设=按剧本自动推断;custom 时用 ethnicity_note 写自由描述'),
      ethnicity_note: z.string().optional().describe("ethnicity='custom' 时的自由文本(如 北欧/波斯);其余取值忽略"),
      project_type: z.enum(['drama', 'ad', 'mv', 'brand_film']).optional()
        .describe('项目类型(默认 drama)。ad=广告(改写走 ad_script_rewriter);mv=音乐(走歌词→故事→剧本子流程);brand_film=品牌微电影(默认16:9)'),
      rewrite_mode: z.enum(['standard', 'director']).optional().describe('AI改写深度:standard 或 director(导演级)'),
      rewrite_pipeline: z.enum(['auto', 'two_pass', 'single_forced']).optional().describe('改写流水线:auto(默认,按原稿形态智能路由——剧本形态走两步保真,小说/大纲走创作改写)/two_pass(强制两步保真,客户自带成熟剧本必选)/single_forced(强制单步创作)'),
      fidelity_enforce: z.number().int().min(0).max(1).optional().describe('1=改写保真硬闸:丢台词/丢人物/丢动作节拍直接拒收重做(客户要求逐句保留时开)'),
      director_style: z.string().optional().describe('导演风格包 key'),
      ...PROJECT_SETTINGS_FIELDS,
    },
    async (args) => {
      const { ethnicity, ethnicity_note, ...rest } = args
      const body: Record<string, unknown> = { ...rest }
      const lock = buildEthnicityLock(ethnicity, ethnicity_note)
      if (lock) body.ethnicity_lock = lock
      return jsonResult(await client.producePost('/dramas', body))
    },
  )

  // ---------- 灌本(原始内容) ----------
  server.tool(
    'set_script',
    '给某一集设置**原始剧本**(content)。这是 AI 改写的输入,不是最终可拍稿。免费。' +
      '梗概/大纲/自己写好的成品稿都放这里,设完**必须调 rewrite_script 做 AI 改写**——' +
      '不能跳过改写直接把稿子贴进 edit_rewritten_script(会被拒)。' + WORKFLOW_HINT,
    {
      episode_id: z.number().int().positive(),
      script: z.string().min(1).describe('该集的原始剧本文本(原稿)'),
    },
    async ({ episode_id, script }) =>
      jsonResult(await client.producePut(`/episodes/${episode_id}/script`, { content: script })),
  )

  // ---------- AI 改写 / 审阅 / 改稿 ----------
  server.tool(
    'rewrite_script',
    'AI 改写:把原始剧本改写成可拍稿(读 content → 写 script_content)。按项目类型自动选改写 agent' +
      '★保真自动路由:原稿已是剧本形态时自动走两步保真(台词逐句机器锁定、AI 不加戏,剧作缺口进 dramaturgy_suggestions 由客户决定);原稿是小说/大纲则走创作型改写。' +
      '(广告走 ad 改写;MV 不走标准改写会被拦)。后台异步(分钟级),文本步按 token 后付、不欠费,无需报价。' +
      '完成后用 get_script 审阅、edit_rewritten_script 改稿。' +
      '★典型耗时 2~4 分钟(生产实测 ≈169 秒)。**60 秒内查不到结果是正常的,不是失败**——' +
      '用 get_run_status 判断还在不在跑,别急着重发。' +
      '★★**本工具是"从原稿整篇重来",不是"再改一版"**:已有可拍稿时重跑会把当前稿连同已做的所有修正' +
      '一起覆盖,而且新一版**不保证保留旧版已经改好的地方**(生产三版实测:上一版拆好的长旁白段下一版又' +
      '合回去、上一版正确的年代服装下一版漂走)。响应里的 overwrites_existing_script=true 就是这个意思。' +
      '所以**首次改写成功之后,后续所有修改一律用 edit_rewritten_script 点改**——免费、秒级、只动指定的' +
      '那几场,其余逐字不变,结果确定不抽卡;只有"要一个完全不同的版本"才重跑本工具。' +
      '误重跑后用 get_script(include_previous=1) 取回上一版。' + WORKFLOW_HINT,
    { episode_id: z.number().int().positive() },
    async ({ episode_id }) => jsonResult(await client.producePost(`/episodes/${episode_id}/rewrite`)),
  )
  server.tool(
    'get_script',
    '读某一集的原始内容 + AI 改写后的可拍稿 + 改写状态 + dramaturgy_suggestions(两步保真模式下 AI 识别到但未自动补的剧作缺口——钩子/情感锚点;把它转述给客户决定采纳与否,忽略不影响产线)。免费。' +
      '★改稿工作流:先用本工具取回 rewritten_script 全文 → 只改客户要改的那几场 → 用 edit_rewritten_script 提交(不要重跑改写)。' +
      'previous_script_available=true 表示有上一版快照;传 include_previous=1 可取回上一版全文(误重跑/改坏了的回捞路径,默认不带以免响应翻倍)。',
    {
      episode_id: z.number().int().positive(),
      include_previous: z.boolean().optional().describe('取回上一版可拍稿全文(previous_script 快照)。默认 false;改坏了或误重跑时用'),
    },
    async ({ episode_id, include_previous }) =>
      jsonResult(await client.produceGet(`/episodes/${episode_id}/script${include_previous ? '?include_previous=1' : ''}`)),
  )
  server.tool(
    'edit_rewritten_script',
    '★改稿的**首选通道**:改 AI 改写后的可拍稿(写 script_content)。免费、秒级、结果确定不抽卡——' +
      '**改写成功一次之后,所有修改都走这里,不要重跑 rewrite_script**(那是从原稿整篇重来,当前稿的修正全丢、' +
      '已改好的地方会退回去)。' +
      '★怎么点改(三步,别跳):① get_script 取回 rewritten_script **全文**;② **只改要改的那几场**——' +
      '目标场次内改动词句/拆场/删挂错的 motif/补 [SFX]/移器物到 [道具] 行,其余场次连标点都逐字照抄;' +
      '③ 把改完的**整篇**提交本工具(本工具是全文覆盖,所以未改动部分必须原样带回,不能只发片段、也不要让模型' +
      '"顺手重写"没让它改的场)。典型可点改的问题:场次太长要拆、台词跨镜断句、时段/年代写错、' +
      'motif 挂在没有该元素的场、[角色档案] 服装段混进手持器物、缺 [SFX]/[BGM] 标注。' +
      '只用于修改 AI 改写产出的稿;本集还没跑过 rewrite_script 时会被 400 拒——这不是绕过改写的通道,' +
      '别把自己写好的剧本直接贴进来。改坏了可用 get_script(include_previous=1) 取回上一版。免费。',
    {
      episode_id: z.number().int().positive(),
      script: z.string().min(1).describe('改好的可拍剧本(覆盖 AI 改写稿)'),
    },
    async ({ episode_id, script }) =>
      jsonResult(await client.producePut(`/episodes/${episode_id}/rewritten-script`, { script_content: script })),
  )

  // ---------- 提取(角色/场景/道具) ----------
  server.tool(
    'extract_assets',
    '从可拍稿提取角色/场景/道具(一次写三表,是下游一致性的地基)。后台异步,文本步后付不欠费。' +
      '前置:已 rewrite_script 产出改写稿(新项目强制;人物档案从改写稿提取才与剧本、分镜自洽)。' +
      '★分钟级后台任务;用 get_run_status 判断是否还在跑,别拿 60 秒当失败判据。' +
      REVIEW_GATE_HINT('review_script', '改写稿') + WORKFLOW_HINT,
    { episode_id: z.number().int().positive(), ...REVIEW_ARGS },
    async ({ episode_id, review_token, acknowledge_review }) =>
      jsonResult(await client.producePost(`/episodes/${episode_id}/extract`, { review_token, acknowledge_review })),
  )

  // ---------- 完整工作流进度 ----------
  server.tool(
    'get_pipeline_status',
    '查某一集完整工作流的进度(script_rewrite/提取/分镜/语音/出图/出视频/合成/配乐/终拼…各步 ' +
      'done/partial/pending/not_required)。照它按序推进、不跳步。免费。' +
      '★not_required=当前模式不需要该步(如原声剧的 TTS 三步、关配乐的 generate_bgm),不是没做完,别去补做。' +
      '图片/视频分母已剔除卡镜(shots_not_applicable);merge_episode.bgm_stale=true 表示配乐晚于成片,重新 compose_episode 即可。',
    { episode_id: z.number().int().positive() },
    async ({ episode_id }) => jsonResult(await client.produceGet(`/episodes/${episode_id}/pipeline-status`)),
  )

  // ---------- 角色定妆图(一致性锚) ----------
  server.tool(
    'quote_character_portraits',
    '报价:给缺定妆图的角色批量出定妆图要多少点。返回 portraits_to_generate、estimated_points、quote_id。零扣费。' +
      '定妆图是身份一致性的锚(缺它角色会漂移),强烈建议出视频前先出。',
    { episode_id: z.number().int().positive() },
    async ({ episode_id }) => jsonResult(await client.producePost(`/episodes/${episode_id}/portraits/quote`)),
  )
  server.tool(
    'generate_character_portraits',
    '确认后批量出角色定妆图(★仅定妆图):后台异步。定妆图只是单张身份锚——镜头一致性(尤其服装)还需**设定图**,' +
      '出完定妆图强烈建议 generate_character_sheets;或直接用 generate_portraits_and_sheets 一步到位。' +
      '用 get_pipeline_status/get_storyboards 查进度。' + CONFIRM_HINT,
    { episode_id: z.number().int().positive(), quote_id: z.string().describe('来自 quote_character_portraits') },
    async ({ episode_id, quote_id }) =>
      jsonResult(await client.producePost(`/episodes/${episode_id}/portraits/generate`, { quote_id })),
  )
  // ---------- 设定图(镜头一致性根锚·批量 / 一键) ----------
  server.tool(
    'generate_character_sheets',
    '★批量给全剧角色出设定图(多视角 turnaround)。设定图是镜头帧/视频引用的**一致性根锚**——只出定妆图不出设定图,' +
      '镜头人物换角度/换光/服装会漂移(2.5 更直接用设定图切片做骨相锚)。只对缺设定图的角色出(不重复扣费)。' +
      '前置:角色须已有定妆图(缺则拦并提示先出定妆图)。图片步,按用量后付不欠费。轮询 get_characters 看 sheet_status:' +
      'pending=生成/审计中(设定图约 2~4 分钟,别重复点);ready=入库;**rejected=图已出但被一致性闸拒收**,' +
      '读 sheet_fail_hint 拒收判词——可重掷一次,连拒理由相同则是锚字段与人物档案冲突,先 run_precheck 再重掷。',
    { episode_id: z.number().int().positive() },
    async ({ episode_id }) => jsonResult(await client.producePost(`/episodes/${episode_id}/character-sheets`)),
  )
  server.tool(
    'generate_portraits_and_sheets',
    '★一键:定妆图 + 设定图(推荐,产线标配)。设定图强依赖定妆图,故智能两阶段——有角色缺定妆图就先派定妆图并提示,' +
      '定妆图齐了再调一次即批量出设定图。避免只出定妆图导致镜头漂移。图片步,按用量后付不欠费。' +
      '轮询 get_characters 看 image/sheet_url 就绪;每调一次推进一步。',
    { episode_id: z.number().int().positive() },
    async ({ episode_id }) => jsonResult(await client.producePost(`/episodes/${episode_id}/portraits-and-sheets`)),
  )

  // ---------- 拆镜(storyboards) ----------
  server.tool(
    'quote_storyboards',
    '报价:把某一集的剧本拆成分镜(storyboards)要多少点。返回 estimated_points 与 quote_id。零扣费。' +
      '拿到后把点数告诉用户征求同意,再用 quote_id 调 generate_storyboards。',
    { episode_id: z.number().int().positive() },
    async ({ episode_id }) =>
      jsonResult(await client.producePost(`/episodes/${episode_id}/storyboards/quote`)),
  )
  server.tool(
    'generate_storyboards',
    '确认后拆镜:后台跑(分钟级),立即返回 status:generating。用 get_storyboards 轮询。' +
      '★注意:拆镜会**替换整集所有已有分镜**(已调好/已出图的全丢、要重花钱重来)。每镜 5-7 秒是对 AI 出视频' +
      '优化的**正常**时长,别因「一镜偏长」觉得有问题就重拆。已有分镜时后端会拦,确认重拆才带 confirm_replace=true。' +
      '★典型耗时 5~10 分钟(生产实测 7~8.4 分钟;**单次 LLM 调用就可能 3~7 分钟**)。' +
      '**60 秒、甚至 3 分钟内查不到分镜都是正常的**——用 get_run_status 判断是否还在跑。' +
      'running:true 就继续等;重发一次等于把整集分镜重来一遍。' +
      REVIEW_GATE_HINT('review_script', '改写稿') + CONFIRM_HINT,
    {
      episode_id: z.number().int().positive(),
      quote_id: z.string().describe('来自 quote_storyboards'),
      confirm_replace: z.boolean().optional().describe('本集已有分镜时必须 true 才重拆(会替换整集所有分镜,已出图白费)'),
      ...REVIEW_ARGS,
    },
    async ({ episode_id, quote_id, confirm_replace, review_token, acknowledge_review }) =>
      jsonResult(await client.producePost(`/episodes/${episode_id}/storyboards/generate`, {
        quote_id, review_token, acknowledge_review, ...(confirm_replace ? { confirm_replace } : {}),
      })),
  )
  server.tool(
    'get_storyboards',
    '读某一集的分镜列表(供审阅/查进度)。含每镜首帧(first_frame_image)与视频(video_url)是否就绪。' +
      '★每镜还带**结构化状态**:frame_status/video_status(ready/pending/authorizing/rejected/failed/none/not_required)、' +
      '★not_required=旁白/片尾卡镜:帧与视频由成片层渲染,本镜不需要生成——数补齐进度时把它当已完成,别重试。' +
      'fail_reason(sensitive/text_sensitive/copyright/face_mismatch/account_overdue/quota_full/authorizing/' +
      'insufficient_credits/transient)、retryable(true=可重试;false=改内容换图,重试无效)、fail_hint(人读文案)。' +
      '照 retryable 判该重试还是该改内容,别解析中文。' +
      '★first_frame_source/last_frame_source=\'upload\' 表示该帧是**外部上传图**(绕开了身份锚/画风锚/' +
      'best-of-N/帧审计整条质量链路)——人物·服装·画风漂移排查先看这些镜;外部图导致的漂移不是平台生成质量问题,' +
      '修复正路是删掉外部图改走 generate_shot_frame 平台重生。' +
      '★若某镜带 reopen_pair_id:该镜首尾帧同时生成时只有一侧真的有问题、另一侧是无辜陪拒,' +
      '原样传给 generate_shot_frame 的 reopen_pair_id 参数可以只重掷有问题的那一侧(省一半算力/费用,' +
      '不会拿去生成一张这次根本没打算重做的图)。没有这个字段就按 fail_reason/retryable 走常规重试。免费。',
    { episode_id: z.number().int().positive() },
    async ({ episode_id }) =>
      jsonResult(await client.produceGet(`/episodes/${episode_id}/storyboards`)),
  )

  // ---------- 在途运行状态(免费):区分「还在跑」和「已经死了」----------
  server.tool(
    'get_run_status',
    '(★免费·长耗时操作后必用)查这一集当前有没有 agent 正在跑。' +
      'rewrite_script / extract_assets / generate_storyboards 都是**分钟级**后台任务,' +
      '它们只回一句 status:"generating",本工具是唯一能区分「还在跑」与「已经结束」的手段。\n' +
      '★典型耗时(生产实测):改写 2~4 分钟、拆镜 5~10 分钟——**单次 LLM 调用就可能 3~7 分钟**。' +
      '所以 60 秒内查不到结果是完全正常的,绝不是失败。\n' +
      '用法:发起后每 30~60 秒调一次。running:true = 还在跑,继续等,**千万不要重发**' +
      '(重发拆镜会替换整集分镜,已调好/已出图的全丢、要重花钱);' +
      'running:false = 那次已经结束,这时才去 get_storyboards / get_script 看产物有没有落库。\n' +
      '⚠️ 服务重启会让在途登记归零,重启期间发起的运行也会显示为无在途。',
    { episode_id: z.number().int().positive() },
    async ({ episode_id }) => jsonResult(await client.produceGet(`/episodes/${episode_id}/run-status`)),
  )

  // ---------- 分镜级 AI 操作:2 个免费质量闸 + 3 个 AI 增强(★都在出图前做)----------
  server.tool(
    'run_precheck',
    '(★推荐·免费质量闸)出图/出视频前跑生成前预检,把会被拒的镜提前揪出。免费、不扣费。' +
      '强烈建议 generate_frames/generate_videos 前调,防白花钱被拒。\n' +
      '查这几类:①真人肖像/克隆音色授权 ②图像审核高危词 ③配音覆盖与大空档 ' +
      '④**指令自相矛盾(kind=prompt-conflict)**——同一镜里互斥的要求(如宽景别却标了特写主体、' +
      '既要站立又要坐姿),这类镜**任何正确的图都满足不了**,不改就会反复被拒并反复扣费,' +
      '出现时应先按提示改分镜再出图,而不是重试。\n' +
      '⚠️ 它**不**检查首帧是否处在"动作发生前"(平台暂无该契约字段),也不替代 get_health_report。',
    { episode_id: z.number().int().positive() },
    async ({ episode_id }) => jsonResult(await client.produceGet(`/episodes/${episode_id}/precheck`)),
  )
  server.tool(
    'get_health_report',
    '(★推荐·免费诊断)读分镜出体检报告:时长超标/母题覆盖不足/问题镜。纯读、免费。出图前查,识别问题先改再出、别出了片才发现。',
    { episode_id: z.number().int().positive() },
    async ({ episode_id }) => jsonResult(await client.produceGet(`/episodes/${episode_id}/health-report`)),
  )

  // ---------- 分阶段审查(三道硬闸的凭据来源;全部免费) ----------
  // 每层审查返回 { pass, error_count, warning_count, findings[], review_token }。
  // findings 每条 = { level, code, shots?, count?, action } —— code 是稳定问题类型码、
  // action 直接告诉你该调哪个工具去修,照着做即可,不需要理解平台内部判据。
  server.tool(
    'review_script',
    '【第①道硬闸·免费】审查 AI 改写稿:对白行长度、情绪转折完整性、开场钩子、末场悬念。' +
      '★extract_assets 与 generate_storyboards 之前必须先跑本工具——人物档案和分镜都从改写稿派生,' +
      '稿子里的问题会被逐层放大到定妆图/出图/出视频,等成片才发现就是整集重来。' +
      '把 findings 逐条告诉客户、按 action 修完(改稿走 edit_rewritten_script)后复审,再拿 review_token 往下走。',
    { episode_id: z.number().int().positive() },
    async ({ episode_id }) => jsonResult(await client.producePost(`/episodes/${episode_id}/review/script`)),
  )
  server.tool(
    'review_storyboards',
    '【第②道硬闸·免费】审查分镜:禁区词(会被厂商审核拒、白扣费)、镜头时长分布、相邻构图重复、' +
      '同场景角色站位漂移、情绪曲线峰谷、关键镜标记。★generate_frames 之前必须先跑本工具——' +
      '分镜里的问题一旦整集出图就变成整集废图,单镜修不回来。按 findings.action 用 update_shot/split_shot 修完再复审。',
    { episode_id: z.number().int().positive() },
    async ({ episode_id }) => jsonResult(await client.producePost(`/episodes/${episode_id}/review/storyboards`)),
  )
  server.tool(
    'review_frames',
    '【第③道硬闸·免费】审查镜头图片层:角色身份锚覆盖(缺定妆图的角色在镜头里必漂)、出图失败率、' +
      '孤儿角色变体、场景图被人物污染。★generate_videos 之前必须先跑本工具——出视频是全链最贵的一步,' +
      '拿着漂移的首帧整集出视频是最典型的废片形态。按 findings.action 修完(多为 generate_character_portraits / ' +
      'generate_shot_frame 单镜重生)再复审。',
    { episode_id: z.number().int().positive() },
    async ({ episode_id }) => jsonResult(await client.producePost(`/episodes/${episode_id}/review/frames`)),
  )
  server.tool(
    'review_all',
    '(推荐·免费)三层一次跑完的整体体检:剧本+分镜+镜头图片。开工前摸底、交付前复查用。' +
      '★它**不发 review_token** —— 进收费步前仍需对应层的 review_script / review_storyboards / review_frames 各跑一次' +
      '(闸认的是「针对当前产出物刚审过」,不是「审过一次」)。',
    { episode_id: z.number().int().positive() },
    async ({ episode_id }) => jsonResult(await client.producePost(`/episodes/${episode_id}/review/all`)),
  )
  server.tool(
    'autofill_storyboards',
    '(推荐)AI 一键给全集分镜补全空缺字段,默认**只填空缺、不覆盖已有**(overwrite=true 才覆盖)。提升分镜完整性,出图前做。后台异步,文本步后付。',
    { episode_id: z.number().int().positive(), overwrite: z.boolean().optional().describe('true=覆盖已有字段(默认 false 只填空缺)') },
    async ({ episode_id, overwrite }) => jsonResult(await client.producePost(`/episodes/${episode_id}/storyboards/autofill`, overwrite ? { overwrite } : {})),
  )
  server.tool(
    'enhance_shot_prompts',
    '(可选增强·★非必须·有副作用)AI 批量增强全集 image_prompt。★会**改写已有 prompt**(含手调的);且**务必 generate_frames 之前**做——' +
      '出图后再改 prompt 会让图陈旧、要重生浪费钱。非跑通一部片的必需,客户点名再做。后台异步,文本步后付。',
    { episode_id: z.number().int().positive() },
    async ({ episode_id }) => jsonResult(await client.producePost(`/episodes/${episode_id}/storyboards/enhance-prompts`)),
  )
  server.tool(
    'complete_ending_motifs',
    '(可选增强·★非必须·条件性)给结尾段补全缺失的视觉母题(嫁接视觉回响到结尾镜)。' +
      '★前置:该剧已设 motifs(没设=空操作);会**改结尾镜 action/描述**,务必出图前做(否则结尾镜已出图会陈旧)。后台异步,文本步后付。',
    { episode_id: z.number().int().positive() },
    async ({ episode_id }) => jsonResult(await client.producePost(`/episodes/${episode_id}/storyboards/complete-motifs`)),
  )

  // ---------- 出首帧(frames) ----------
  server.tool(
    'quote_frames',
    '报价:给某一集批量出帧要多少点。返回 frames_to_generate、estimated_points、quote_id。零扣费。' +
      'frame_type 默认 first_frame(只给缺首帧的镜出);last_frame 只给「已有首帧且缺尾帧」的镜出;both 两者都补。' +
      '★报价按**实际会用的模型与分辨率**分档,响应带 price_breakdown(逐档张数与单价);' +
      '打算在 generate_frames 里临时换模型,报价时就要把同一个 image_model 传进来,否则两边不是一个价。',
    {
      episode_id: z.number().int().positive(),
      frame_type: FRAME_TYPE_ARG.optional().describe('默认 first_frame;last_frame=补尾帧;both=首尾都补'),
      image_model: z.string().optional().describe('按这个模型报价(须与随后 generate_frames 传的一致;不传=用 drama 级设定,默认香蕉2)'),
    },
    async ({ episode_id, frame_type, image_model }) =>
      jsonResult(await client.producePost(`/episodes/${episode_id}/frames/quote`, { frame_type, image_model })),
  )
  server.tool(
    'generate_frames',
    '确认后批量出帧:后台异步。用 get_storyboards 轮询,first_frame_image/last_frame_image 逐镜填充即完成。' +
      '★图片生成较慢——每张几十秒到数分钟(尤其高清模型),整集可能十几分钟。轮询看 frame_status:' +
      '**pending=还在生成(继续耐心等,别当失败、别重复调 generate_frames,重复触发=白花钱)**、' +
      'ready=完成、failed=才是真失败。别因为「等了一会儿还没出」就判定生成失败或重试。' +
      '出视频前必须先出帧,否则视频会退化成无一致性锚点的画面。' +
      'frame_type 要与 quote_frames 用的一致(默认 first_frame)。' +
      '★这是**批量补缺帧**:只给「缺该帧」的镜出图,已有首帧的镜会跳过——这是正常设计、不是"系统拒绝重出"。' +
      '要**重出/重画某一镜已有的帧**(如换了定妆图要让新图生效),用 generate_shot_frame(单镜重生,平台带身份锚),不是这个工具、更不是自制图 upload_shot_frame。' +
      '★尾帧能批量出:frame_type=last_frame 会给「已有首帧且缺尾帧」的镜批量补尾帧(尾帧只在想固定某镜结尾画面/大运镜时才需,常规只出首帧)。' +
      '★响应里的 frames_planned 是**计划数,不是已成功数**——本接口在后台派发循环开跑之前就返回了。' +
      '真实进度只看 get_storyboards 的 first_frame_image / get_jobs 的逐条生成记录;' +
      '余额不足(402)会中止整批,此时轮询再久也不会有结果,应去查余额而不是继续等。' +
      REVIEW_GATE_HINT('review_storyboards', '分镜') + CONFIRM_HINT,
    {
      episode_id: z.number().int().positive(),
      quote_id: z.string().describe('来自 quote_frames'),
      ...REVIEW_ARGS,
      frame_type: FRAME_TYPE_ARG.optional().describe('默认 first_frame,须与报价时一致'),
      image_model: z.string().optional().describe('临时覆盖本次出图模型(不传=用 drama 级设定,默认香蕉2)。可选:' +
        'gemini-3.1-flash-image(Nano Banana 2·默认·71点)/gemini-3-pro-image(Nano Banana Pro·更精细·175点)/' +
        'gemini-3.1-flash-lite-image(Nano Banana 2 Lite·便宜·31点)/doubao-seedream-5-0-260128(Seedream 5.0)/gpt-image-2(ChatGPT Image 2)'),
    },
    async ({ episode_id, quote_id, frame_type, image_model, review_token, acknowledge_review }) =>
      jsonResult(await client.producePost(`/episodes/${episode_id}/frames/generate`, {
        quote_id, frame_type, image_model, review_token, acknowledge_review,
      })),
  )

  // ---------- 单镜出帧/重生(改某一镜的画面走这里,别去外部平台出图再传回来) ----------
  server.tool(
    'quote_shot_frame',
    '报价:重画/补出**某一镜的某一帧**要多少点(一帧=一张图)。返回 estimated_points、quote_id。零扣费。' +
      '客户说「第 N 镜画错了/要改」时用它,而不是拿别的图像平台出图再 upload_shot_frame。' +
      '★响应带 billing_kind/unit_points(实际计费档与单价);要在 generate_shot_frame 里换模型,报价时传同一个 image_model。',
    {
      storyboard_id: z.number().int().positive(),
      frame_type: FRAME_TYPE_ARG.optional().describe('默认 first_frame;both=首尾各一张'),
      image_model: z.string().optional().describe('按这个模型报价(须与随后 generate_shot_frame 传的一致;不传=用 drama 级设定,默认香蕉2)'),
    },
    async ({ storyboard_id, frame_type, image_model }) =>
      jsonResult(await client.producePost(`/storyboards/${storyboard_id}/frame/quote`, { frame_type, image_model })),
  )
  server.tool(
    'generate_shot_frame',
    '确认后给**某一镜**出帧或重生该帧(异步)。这是修某一镜画面的正路:平台会带上该镜的角色身份锚、' +
      '场景/道具参考图、画风锚与帧审计,重生出的图与全片一致;用外部工具出图再上传会绕开这整条链路,人物/服装/画风必漂。' +
      '重生会覆盖该帧现有图(含此前上传的),并把本镜视频标为待重生。尾帧需本镜首帧已就绪(否则先用 first_frame 或 both)。' +
      '完成判据:轮询 get_storyboards 看该镜 first_frame_image/last_frame_image 变化。\n' +
      '★继承重开(reopen_pair_id):get_storyboards 某镜带这个字段时,原样传进来可以只重掷首尾帧里' +
      '真正有问题的那一侧——另一侧此前已经生成好的候选原样保留,不重新生成、不重新计费。传了它就' +
      '不用再传 frame_type(会被忽略,由平台判定该重哪一侧);quote_id 仍要用 quote_shot_frame 报价' +
      '(frame_type 传 first_frame 或 last_frame 均可,单帧同价)。若该镜没有 reopen_pair_id 字段' +
      '(不满足继承条件),这个参数不要传,走常规 frame_type 重试。' + CONFIRM_HINT,
    {
      storyboard_id: z.number().int().positive(),
      quote_id: z.string().describe('来自 quote_shot_frame'),
      frame_type: FRAME_TYPE_ARG.optional().describe('默认 first_frame,须与报价时一致;传了 reopen_pair_id 时会被忽略'),
      replace_user_frame: z.boolean().optional().describe('默认 true(显式重生允许覆盖已上传帧);传 false 则保护已上传帧'),
      reopen_pair_id: z.string().optional().describe('来自 get_storyboards 该镜的同名字段;只重掷有问题的那一侧,不必再传 frame_type'),
      image_model: z.string().optional().describe('临时覆盖本次重画的图片模型(不传=用 drama 级设定,默认香蕉2);取值同 generate_frames'),
    },
    async ({ storyboard_id, quote_id, frame_type, replace_user_frame, reopen_pair_id, image_model }) =>
      jsonResult(await client.producePost(`/storyboards/${storyboard_id}/frame/generate`, { quote_id, frame_type, replace_user_frame, reopen_pair_id, image_model })),
  )

  // ---------- 出视频(videos,大额) ----------
  server.tool(
    'quote_videos',
    '报价:给某一集所有分镜批量出视频要多少点(与实际扣费同函数,较准)。返回 estimated_points、quote_id。零扣费。' +
      '⚠️ 视频是大额花费,务必把点数清楚告诉用户并等其确认。',
    { episode_id: z.number().int().positive() },
    async ({ episode_id }) =>
      jsonResult(await client.producePost(`/episodes/${episode_id}/videos/quote`)),
  )
  server.tool(
    'generate_videos',
    '确认后批量出视频:一条后台链跑完整集,余额不足会自动中止整链(防重复扣)。' +
      '要求本集已出首帧(未出会被拒)。用 get_storyboards 轮询 video_url 逐镜填充即完成。' +
      REVIEW_GATE_HINT('review_frames', '镜头图片') + CONFIRM_HINT,
    {
      episode_id: z.number().int().positive(),
      quote_id: z.string().describe('来自 quote_videos'),
      ...REVIEW_ARGS,
    },
    async ({ episode_id, quote_id, review_token, acknowledge_review }) =>
      jsonResult(await client.producePost(`/episodes/${episode_id}/videos/generate`, { quote_id, review_token, acknowledge_review })),
  )

  // ---------- 成片(compose/终拼) ----------
  server.tool(
    'compose_episode',
    '把某一集所有镜头视频拼成一条成片(终拼)。**免费**(纯拼接,无需报价确认),后台异步。' +
      '发起前有终拼预检:缺视频的镜或仍在生成中的视频任务会 400 硬阻断并列出问题镜(blockers),' +
      '补齐后重试;确要拼部分成片传 force=true(缺视频镜被跳过,成片缺镜,留痕)。' +
      '响应里的 advisories(时长偏差/孤儿任务/缺TTS)只提醒不阻断,建议逐条处理后再拼。发起后用 get_final_cut 轮询。',
    {
      episode_id: z.number().int().positive(),
      force: z.boolean().optional().describe('true=预检有硬阻断也强制照拼(默认拦截)。缺视频的镜会被静默跳过,成片为部分'),
    },
    async ({ episode_id, force }) =>
      jsonResult(await client.producePost(`/episodes/${episode_id}/compose`, force ? { force: true } : {})),
  )
  server.tool(
    'get_final_cut',
    '查某一集成片状态与下载链接。status=completed 时返回 download_url(我方 COS 直链,可直接下载)。免费。' +
      '★bgm_stale=true 表示配乐在成片之后生成/改动、尚未进成片:重新 compose_episode(免费)即可,别用 re-render。',
    { episode_id: z.number().int().positive() },
    async ({ episode_id }) => jsonResult(await client.produceGet(`/episodes/${episode_id}/final-cut`)),
  )
  server.tool(
    'get_export',
    '查某一集导出/母版状态(成片终拼后的可下载母版)。免费。',
    { episode_id: z.number().int().positive() },
    async ({ episode_id }) => jsonResult(await client.produceGet(`/episodes/${episode_id}/export`)),
  )

  // ========== 项目设定(建后可改)==========
  server.tool(
    'update_project_settings',
    '建剧后修改项目设定。除画幅/分辨率/世界观Brief/族裔/题材/导演风格外,现覆盖★整剧视觉一致性锚' +
      '(摄影DNA cinematography_prompt/美术圣经 art_bible/视觉锁定 visual_lock/视频风格正负向词/视觉母题 motifs)、' +
      '音频(bgm_source 自有vs原生/bgm_volume_preset 音量/use_clip_audio 用视频原声)、' +
      '字幕(show_subtitles/双语 subtitle_secondary_lang/位置/边距/动效)、转场——即项目设定页全部通用设定。免费。' +
      '⚠️ 世界观 Brief/族裔/画幅/一致性锚等改后,已生成的内容不会自动更新,需重生对应内容。',
    {
      drama_id: z.number().int().positive(),
      genre: z.string().optional(),
      style: z.string().optional(),
      description: z.string().optional(),
      tags: z.array(z.string()).optional(),
      aspect_ratio: z.enum(ASPECT_RATIOS).optional(),
      // v0.1.39 — 画幅锁定闸:本剧已有分镜/生成资产后改画幅会被 400 拦(已生成内容会漂移),
      // 确认要改必须显式带 true。通常正解是建剧时定好画幅、之后不改。
      confirm_aspect_change: z.boolean().optional(),
      video_resolution: z.enum(VIDEO_RESOLUTIONS).optional(),
      setting_brief: z.string().optional().describe('世界观 Brief(ERA LOCK)'),
      ethnicity: z.enum(ETHNICITY_CODES).optional().describe('角色族裔锁'),
      ethnicity_note: z.string().optional(),
      rewrite_mode: z.enum(['standard', 'director']).optional(),
      rewrite_pipeline: z.enum(['auto', 'two_pass', 'single_forced']).optional().describe('改写流水线:auto 默认智能路由/two_pass 强制两步保真/single_forced 强制单步创作'),
      fidelity_enforce: z.number().int().min(0).max(1).optional().describe('1=改写保真硬闸(丢台词即拒)'),
      director_style: z.string().optional(),
      theme_statement: z.string().optional().describe('一句话主题'),
      subtitle_preset: z.string().optional(),
      scene_group_mode: z.boolean().optional().describe('长镜模式(连续动作/电影级长镜)'),
      // 广告专属
      cta_text: z.string().optional(),
      target_duration_s: z.number().optional(),
      brand_voice: z.string().optional(),
      // 品牌微电影专属
      narrative_tone: z.string().optional(),
      story_structure: z.string().optional(),
      end_card_variant: z.string().optional(),
      // MV 专属
      mv_lyrics: z.string().optional(),
      mv_audio_url: z.string().optional(),
      ...PROJECT_SETTINGS_FIELDS,
    },
    async (args) => {
      const { drama_id, ethnicity, ethnicity_note, ...rest } = args
      const body: Record<string, unknown> = { ...rest }
      const lock = buildEthnicityLock(ethnicity, ethnicity_note)
      if (lock) body.ethnicity_lock = lock
      return jsonResult(await client.producePut(`/dramas/${drama_id}`, body))
    },
  )

  // ========== 项目设定页子资源(可选增强,提升一致性/风格锁)==========
  server.tool(
    'generate_world_concept',
    '(★默认必做·很多第三方平台漏做这步·仍走报价确认)生成世界观概念图(固定4格:全景/时代/主场景/色彩),提升整剧视觉一致性。' +
      '★分镜后默认调这个,别跳过;但仍要告知客户预估点数、客户确认才跑(不静默扣费)。需 setting_brief ≥30字。图片步,按固定成本后付、不欠费。',
    { drama_id: z.number().int().positive() },
    async ({ drama_id }) => jsonResult(await client.producePost(`/dramas/${drama_id}/world-concept`)),
  )
  server.tool(
    'generate_art_bible',
    '生成美术圣经(色调/材质/气质,读角色+元数据)。文本步后付不欠费。',
    { drama_id: z.number().int().positive() },
    async ({ drama_id }) => jsonResult(await client.producePost(`/dramas/${drama_id}/art-bible`)),
  )
  server.tool(
    'extract_visual_lock',
    '从世界观 Brief + 角色抽取「视觉锁定」规则(写 visual_lock,统一出图风格/族裔)。文本步后付不欠费。',
    {
      drama_id: z.number().int().positive(),
      setting_brief: z.string().optional().describe('可选:临时覆盖世界观原文'),
    },
    async ({ drama_id, setting_brief }) =>
      jsonResult(await client.producePost(`/dramas/${drama_id}/visual-lock`, setting_brief ? { setting_brief } : {})),
  )
  server.tool(
    'extract_setting_brief',
    '从一段世界观原文提炼简洁的 setting_brief(并存回项目)。文本步后付不欠费。',
    {
      drama_id: z.number().int().positive(),
      raw_text: z.string().min(1).describe('世界观原文'),
    },
    async ({ drama_id, raw_text }) =>
      jsonResult(await client.producePost(`/dramas/${drama_id}/extract-setting-brief`, { raw_text })),
  )
  server.tool(
    'generate_video_style',
    '生成视频风格锁 prompt(读 brief/artBible/visualLock,统一视频生成方向)。文本步后付不欠费。',
    { drama_id: z.number().int().positive() },
    async ({ drama_id }) => jsonResult(await client.producePost(`/dramas/${drama_id}/video-style`)),
  )

  // ========== 剧目级共享资产(可选增强)==========
  server.tool(
    'generate_color_script',
    '生成剧目色彩脚本(统一全片配色情绪)。需该剧/集已有剧本文本。文本步后付不欠费。',
    {
      drama_id: z.number().int().positive(),
      episode_id: z.number().int().positive().optional().describe('可选:按某一集生成'),
    },
    async ({ drama_id, episode_id }) =>
      jsonResult(await client.producePost(`/dramas/${drama_id}/color-script`, episode_id ? { episode_id } : {})),
  )
  server.tool(
    'generate_motion_templates',
    '从分镜自动抽取动作模板(统一全片运动语言)。**需先有分镜**(先 generate_storyboards)。文本步后付不欠费。',
    { drama_id: z.number().int().positive() },
    async ({ drama_id }) => jsonResult(await client.producePost(`/dramas/${drama_id}/motion-templates`)),
  )
  server.tool(
    'quote_scene_images',
    '报价:给缺图场景批量出场景图要多少点。返回 images_to_generate、estimated_points、quote_id。零扣费。',
    { drama_id: z.number().int().positive() },
    async ({ drama_id }) => jsonResult(await client.producePost(`/dramas/${drama_id}/scene-images/quote`)),
  )
  server.tool(
    'generate_scene_images',
    '确认后批量出场景图:后台异步。' + CONFIRM_HINT,
    { drama_id: z.number().int().positive(), quote_id: z.string().describe('来自 quote_scene_images') },
    async ({ drama_id, quote_id }) =>
      jsonResult(await client.producePost(`/dramas/${drama_id}/scene-images/generate`, { quote_id })),
  )

  // ========== A · 客户上传自己的图片 ==========
  server.tool(
    'upload_image',
    '把本地图片上传到我方 COS,返回 image_url(字节直传 COS、不过业务服务器)。' +
      '用于给视频编辑当参考图,或先拿 URL 再登记。免费。',
    {
      file_path: z.string().describe('本地图片绝对路径(jpg/png/webp)'),
      kind: z.enum(['image', 'video', 'audio']).optional().describe('默认 image;视频编辑的参考视频/音频可选 video/audio'),
    },
    async ({ file_path, kind }) => {
      const url = await client.uploadLocalFile(file_path, kind ?? 'image')
      return jsonResult({ image_url: url })
    },
  )
  server.tool(
    'set_character_portrait',
    '用客户自有图片作为角色定妆图(身份锚,优先级高于 AI 生成;之后 AI 重生默认不覆盖)。' +
      '换图会自动失效并重建派生资产(三视图设定图/发型·身材参考)、重建人脸锁。' +
      '★换图后响应含 stale_frames=[{storyboard_id,storyboard_number,frames}]——这些镜的首帧还是旧定妆图生成的、已被污染。' +
      '要让新定妆图生效:对每个 stale_frame 用 quote_shot_frame+generate_shot_frame 重生该镜(平台会自动以新定妆图/设定图/人脸锁作锚,保全片一致)。' +
      '不必逐镜自己指定模型/首尾帧。★千万别自制首尾帧再 upload_shot_frame——外部图没有角色身份锚/画风锚,人物·服装·画风必漂,那才是废片根源(不是"杜绝废片")。' +
      '传本地文件(file_path,自动上传 COS)或已托管的图片 URL(image_url),二选一。免费。',
    {
      character_id: z.number().int().positive(),
      file_path: z.string().optional().describe('本地定妆图路径(与 image_url 二选一;自动上传 COS)'),
      image_url: z.string().optional().describe('已上传的定妆图 URL(与 file_path 二选一)'),
    },
    async ({ character_id, file_path, image_url }) => {
      const url = image_url && image_url.trim()
        ? image_url.trim()
        : (file_path ? await client.uploadLocalFile(file_path, 'image') : '')
      if (!url) throw new Error('file_path 或 image_url 至少提供一个')
      return jsonResult(await client.producePost(`/characters/${character_id}/portrait`, { image_url: url }))
    },
  )
  server.tool(
    'upload_shot_frame',
    '用**客户自有图片**作为某镜的首帧(first_frame)或尾帧(last_frame)。尾帧可选——仅在想固定某镜结尾画面(大运镜/揭示镜)时传;常规只需首帧。会把该镜已有视频标为过期待重生。自动上传+登记。免费。' +
      '⚠️ 只用于客户自己提供的素材。想「重画/修某一镜」请用 generate_shot_frame 让平台重生——' +
      '外部工具出的图不带本片的身份锚与画风锚,贴进来人物/服装/画风会漂。',
    {
      storyboard_id: z.number().int().positive(),
      file_path: z.string().describe('本地帧图路径'),
      frame_type: z.enum(['first_frame', 'last_frame']).optional().describe('默认 first_frame'),
    },
    async ({ storyboard_id, file_path, frame_type }) => {
      const image_url = await client.uploadLocalFile(file_path, 'image')
      return jsonResult(await client.producePost(`/storyboards/${storyboard_id}/frame`, { image_url, frame_type: frame_type ?? 'first_frame' }))
    },
  )
  server.tool(
    'upload_scene_image',
    '用客户自有图片作为某场景的参考图。自动上传+登记。免费。',
    { scene_id: z.number().int().positive(), file_path: z.string().describe('本地场景图路径') },
    async ({ scene_id, file_path }) => {
      const image_url = await client.uploadLocalFile(file_path, 'image')
      return jsonResult(await client.producePost(`/scenes/${scene_id}/image`, { image_url }))
    },
  )
  server.tool(
    'upload_prop_sheet',
    '用客户自有图片作为某道具的设定图。自动上传+登记。免费。',
    { prop_id: z.number().int().positive(), file_path: z.string().describe('本地道具图路径') },
    async ({ prop_id, file_path }) => {
      const image_url = await client.uploadLocalFile(file_path, 'image')
      return jsonResult(await client.producePost(`/props/${prop_id}/sheet`, { image_url }))
    },
  )

  // ========== B · 视频就地编辑 / 剪辑 ==========
  server.tool(
    'get_edit_capabilities',
    '查视频编辑能力开关(就地编辑 / 区间替换是否可用)。免费。',
    {},
    async () => jsonResult(await client.produceGet('/videos/edit-capabilities')),
  )
  server.tool(
    'quote_edit_video_shot',
    '报价:对某镜做就地编辑/区间替换(Seedance 2.5)要多少点。返回 quote_id。零扣费。' +
      '本镜须已有视频。',
    { storyboard_id: z.number().int().positive() },
    async ({ storyboard_id }) => jsonResult(await client.producePost(`/storyboards/${storyboard_id}/edit/quote`)),
  )
  server.tool(
    'edit_video_shot',
    '确认后就地编辑某镜视频:按 instruction 改,可带参考图/视频/音频,或用 start_sec/end_sec 做区间替换。' +
      '可用 model 为本次编辑单独选引擎(与剧引擎可不同):hailuo-3=MiniMax H3 强保真编辑约1/3成本;wan3.0/wan3.0-prime=WAN 3.0 强语义编辑约4折(环境可能跟随指令扩写);' +
      'H3/WAN 均不支持 start_sec/end_sec 区间(传了会 400),编辑/续写的输入视频在 H3/WAN 上另按秒计费。' +
      CONFIRM_HINT,
    {
      storyboard_id: z.number().int().positive(),
      quote_id: z.string().describe('来自 quote_edit_video_shot'),
      instruction: z.string().describe('编辑指令(如"把背景换成夜晚")'),
      model: z.enum(VIDEO_ENGINES).optional().describe('本次编辑的引擎(缺省=跟随剧 video_engine);hailuo-3/wan3.0/wan3.0-prime 不支持区间编辑'),
      reference_image_urls: z.array(z.string()).max(9).optional().describe('参考图 URL(先 upload_image 拿)'),
      reference_video_urls: z.array(z.string()).max(2).optional(),
      reference_audio_urls: z.array(z.string()).max(3).optional(),
      start_sec: z.number().optional().describe('区间替换起点秒'),
      end_sec: z.number().optional().describe('区间替换终点秒'),
    },
    async ({ storyboard_id, ...rest }) =>
      jsonResult(await client.producePost(`/storyboards/${storyboard_id}/edit/generate`, rest)),
  )
  server.tool(
    'quote_regenerate_shot_video',
    '报价:重生某镜视频要多少点。返回 quote_id。零扣费。',
    { storyboard_id: z.number().int().positive() },
    async ({ storyboard_id }) => jsonResult(await client.producePost(`/storyboards/${storyboard_id}/regen/quote`)),
  )
  server.tool(
    'regenerate_shot_video',
    '确认后重生某镜视频(可选新 prompt)。' + CONFIRM_HINT,
    {
      storyboard_id: z.number().int().positive(),
      quote_id: z.string().describe('来自 quote_regenerate_shot_video'),
      prompt: z.string().optional().describe('可选:覆盖该镜视频 prompt'),
    },
    async ({ storyboard_id, quote_id, prompt }) =>
      jsonResult(await client.producePost(`/storyboards/${storyboard_id}/regen/generate`, prompt ? { quote_id, prompt } : { quote_id })),
  )
  server.tool(
    'split_shot',
    '把某镜按首尾帧拆成两镜(结构操作)。免费。',
    { storyboard_id: z.number().int().positive() },
    async ({ storyboard_id }) => jsonResult(await client.producePost(`/storyboards/${storyboard_id}/split`)),
  )
  server.tool(
    'trim_shot',
    '裁剪某镜时长(in_ms/out_ms)。免费;返回后需 rerender_episode 重拼成片。',
    {
      storyboard_id: z.number().int().positive(),
      in_ms: z.number().int().min(0).optional(),
      out_ms: z.number().int().min(0).optional(),
    },
    async ({ storyboard_id, in_ms, out_ms }) =>
      jsonResult(await client.producePut(`/storyboards/${storyboard_id}/trim`, { in_ms, out_ms })),
  )
  server.tool(
    'recommend_trim_window',
    '裁剪窗口动作QC:对「声明时长<真实视频时长」的独立生成镜,按片内活动检测推荐 in/out 裁剪窗口——'
      + '供应商产片动作常在后半段,默认从 0 秒裁会截在半动作态(如抬手没打下去)。免费零扣费。'
      + '组模式镜不适用(组切分已内容感知,返回 applicable=false)。拿到推荐后用 trim_shot 应用。',
    { storyboard_id: z.number().int().positive() },
    async ({ storyboard_id }) =>
      jsonResult(await client.produceGet(`/storyboards/${storyboard_id}/trim/recommend`)),
  )
  server.tool(
    'scan_intra_shot_cuts',
    '★客户报「镜头切太快 / 一个镜头里画面跳来跳去」时先跑这个。免费零扣费。'
      + '一个分镜本应是**一个连续镜头**,但厂商可能在片内自行换机位硬切(望远镜特写→高空全景→人物中景),'
      + '这类切点在分镜表和 timeline 里都看不到——只能扫画面。'
      + '返回 shots_with_cuts(有镜内跳切的镜号)/total_cuts/engine_suspect/message。'
      + '★判读:成片观感切点 = 镜与镜的接缝 + 这里报的镜内跳切;若本项占了大头,那不是剪辑节奏问题,'
      + '重新拆镜或改转场都没用。engine_suspect=true 表示本剧引擎是已知高发源(WAN),'
      + '实测 WAN 11/12 镜有镜内跳切、Seedance 1/6、H3 0/5,且提示词层拦不住(负向约束已在其中)——'
      + '要根治只能 regenerate_shot_video 这些镜并换 seedance-2.5 或 hailuo-3。'
      + '组模式镜与显式快剪蒙太奇镜天然多机位,已自动排除(detail 里标 skipped)。',
    { episode_id: z.number().int().positive() },
    async ({ episode_id }) =>
      jsonResult(await client.produceGet(`/episodes/${episode_id}/intra-shot-cuts`)),
  )
  server.tool(
    'scan_dialogue_coverage',
    '★客户报「话没说完就切 / 台词只念了一半」时先跑这个。默认**免费零扣费**(只读已落库的转录审计结果)。'
      + '把该集每个原声镜的视频音轨与台词做词级比对,按族给出结论:'
      + 'truncated(念到一半就停) / off_script(念的大半不是台词:自说自话、重复上一镜、只有环境音) / '
      + 'extra_speech(台词念全了但还多念) / minor_gap(零星缺词,属转写误差,不必管) / ok。'
      + '★判读:三个可上报的族**处置方向不同**,别一律加长镜头——实测镜长够的镜里仍有 21% 没念全,'
      + '「太短」很少是真因(平台保存分镜时已按台词自动抬时长)。truncated/off_script 的正解都是'
      + ' regenerate_shot_video(厂商每次说多少是随机的,重掷常能拿到整句);同一剧反复 off_script 则换引擎。'
      + '★never_audited 是本报告最重要的一栏:那些镜从没被检测过,「没测过」不等于「没问题」。'
      + 'rescan=true 会对它们补跑 ASR 比对(耗算力、非瞬时,limit 控制单次上限),默认不跑。'
      + 'TTS 配音镜不在范围内(TTS 必然念全,低覆盖率只会是转写误差)。'
      + '同一集若还伴随「切太快」,那是另一回事,跑 scan_intra_shot_cuts。',
    {
      episode_id: z.number().int().positive(),
      rescan: z.boolean().optional()
        .describe('对从未检测过的镜补跑转写比对(耗算力,非瞬时)。默认 false = 只读已有结果'),
      limit: z.number().int().positive().max(60).optional()
        .describe('rescan 单次补测镜数上限,默认 20、最大 60;被上限截掉的镜数在响应 rescan_skipped_by_limit 里明说'),
    },
    async ({ episode_id, rescan, limit }) => {
      const qs = new URLSearchParams()
      if (rescan) qs.set('rescan', '1')
      if (limit != null) qs.set('limit', String(limit))
      const suffix = qs.toString() ? `?${qs.toString()}` : ''
      return jsonResult(await client.produceGet(`/episodes/${episode_id}/dialogue-coverage${suffix}`))
    },
  )
  server.tool(
    'update_shot',
    '逐镜编辑:改单个分镜的文本内容(景别/动作/台词/画面描述/运镜等)与角色绑定(character_ids)。只传要改的字段、其余不动。' +
      '**免费**(纯文本写库)。★改 dialogue 会自动失效本镜已生成的 TTS 配音与字幕(需重出 tts);' +
      '改文本不会自动重出图/视频,如需让画面跟上文本改动,改完再 regen 对应镜。用 get_storyboards 查改后结果。' +
      '★★原声镜(厂商原生音频)改 dialogue 后,本镜视频会被标记「待重生」——因为台词是**烤进视频人声**的,' +
      '不重生就终拼,成片里念的仍是改动前的台词(典型现象:台词像是跑到了别的镜头上)。' +
      'compose_episode 会以 advisory `stale_video_after_edit` 列出这些镜;正确处置是先 regenerate_shot_video 再终拼。',
    {
      storyboard_id: z.number().int().positive(),
      character_ids: z.array(z.number().int().positive()).optional()
        .describe('本镜出场角色 ID 列表(★全量覆盖式,非增量,漏传的角色会被解绑)。决定出图时注入哪些角色的定妆图/设定图——非人角色(动物/生物)也必须绑定,否则形象会漂移。id 必须来自当前集已关联角色'),
      title: z.string().optional().describe('镜头标题'),
      description: z.string().optional().describe('画面描述'),
      shot_type: z.string().optional().describe('景别(如 特写/中景/全景/远景)'),
      angle: z.string().optional().describe('机位角度'),
      camera_movement: z.string().optional().describe('运镜(推/拉/摇/移/跟/固定)'),
      action: z.string().optional().describe('动作描述'),
      dialogue: z.string().optional().describe('台词(★改后自动失效本镜 TTS/字幕,需重出配音)'),
      location: z.string().optional().describe('地点'),
      time: z.string().optional().describe('时间/时段'),
      atmosphere: z.string().optional().describe('氛围'),
      director_note: z.string().optional().describe('导演注释'),
      shot_intent: z.string().optional().describe('这镜为什么存在(叙事意图)'),
    },
    async ({ storyboard_id, ...fields }) => {
      const payload = Object.fromEntries(Object.entries(fields).filter(([, v]) => v !== undefined))
      return jsonResult(await client.producePut(`/storyboards/${storyboard_id}`, payload))
    },
  )
  server.tool(
    'rerender_episode',
    '按当前 timeline 重拼成片(改完镜/裁剪后用)。**免费**(纯 ffmpeg+COS),后台异步。',
    { episode_id: z.number().int().positive() },
    async ({ episode_id }) => jsonResult(await client.producePost(`/episodes/${episode_id}/re-render`)),
  )
  server.tool(
    'replace_shot_dialogue',
    '换某镜对白音色/声线(转写+克隆重配)。后台异步,按用量后付不欠费。要求本镜有原声视频+角色声线定妆音。',
    { storyboard_id: z.number().int().positive() },
    async ({ storyboard_id }) => jsonResult(await client.producePost(`/storyboards/${storyboard_id}/dialogue-replace`)),
  )
  server.tool(
    'generate_bgm',
    '给整集生成/更换 AI 配乐(按情绪弧线)。后台异步,按用量后付不欠费。返回情绪弧线段数与预估耗时;' +
      '用 get_bgm_status 轮询生成进度。★配乐生成/改动**不会自动进已有成片**——完成后必须重新 ' +
      'compose_episode(免费)才能听到;get_final_cut 的 bgm_stale=true 就是在提示这一步。别用 re-render(吃旧时间线,不含新配乐)。',
    { episode_id: z.number().int().positive() },
    async ({ episode_id }) => jsonResult(await client.producePost(`/episodes/${episode_id}/bgm`)),
  )
  server.tool(
    'set_shot_name_card',
    '给某一镜加/改/清「角色名卡」(画面侧边竖排人物名+朱红印章,终拼时烧进成片,含预览一致的书法字体)。' +
      'name 传空字符串=清除本镜名卡。免费(纯数据,填了就显示)。适合群像出场镜逐个标注人物名。' +
      '★别自己下载视频叠字再上传——那会绕开渲染机字体与印章素材,预览/成片不一致。',
    {
      storyboard_id: z.number().int().positive(),
      name: z.string().describe('人物名(竖排渲染);空字符串=清除名卡'),
      seal: z.string().optional().describe('印章文字(默认取名字末字)'),
      side: z.enum(['left', 'right']).optional().describe('名卡在画面哪一侧,默认 right'),
      duration_ms: z.number().int().positive().optional().describe('显示时长毫秒,默认 3000'),
    },
    async ({ storyboard_id, name, seal, side, duration_ms }) =>
      jsonResult(await client.producePut(`/storyboards/${storyboard_id}/name-card`, {
        name, ...(seal !== undefined ? { seal } : {}), ...(side !== undefined ? { side } : {}),
        ...(duration_ms !== undefined ? { duration_ms } : {}),
      })),
  )
  server.tool(
    'get_bgm_status',
    '查某集 AI 配乐生成状态:running(是否在生成)+已入库的配乐轨列表(track/覆盖镜段/淡入淡出)+cue 数。免费。' +
      '配乐 done 后需重新 compose_episode 才进成片。',
    { episode_id: z.number().int().positive() },
    async ({ episode_id }) => jsonResult(await client.produceGet(`/episodes/${episode_id}/bgm-status`)),
  )
  server.tool(
    'translate_subtitles',
    '把某集字幕翻译成第二语言并开启双语。后台异步,按用量后付不欠费。',
    { episode_id: z.number().int().positive(), lang: z.string().describe('目标语言(如 en/ja/ko)') },
    async ({ episode_id, lang }) =>
      jsonResult(await client.producePost(`/episodes/${episode_id}/subtitles/translate`, { lang })),
  )

  // ========== P1 · 读取层(闭环必需:能读回自己建的东西)==========
  server.tool(
    'list_dramas',
    '列出我名下的所有短剧(drama_id/剧名/类型/集数/进度)。免费。',
    {},
    async () => jsonResult(await client.produceGet('/dramas')),
  )
  server.tool(
    'get_drama',
    '读一部剧的详情(设定/角色数/场景数/资产统计等)。免费。',
    { drama_id: z.number().int().positive() },
    async ({ drama_id }) => jsonResult(await client.produceGet(`/dramas/${drama_id}`)),
  )
  server.tool(
    'get_characters',
    '读某一集的角色列表(名字/定妆图/设定图就绪状态)。免费。每角色带结构化状态:' +
      'portrait_status/sheet_status(ready=已入库/pending=生成或审计中·别重复点/rejected=图已生成但被' +
      '一致性闸拒收未入库/failed/none)+ 拒收时的 sheet_fail_reason·sheet_retryable·sheet_fail_hint(拒收判词)。' +
      '★sheet_status=rejected 时照 retryable 判:consistency_rejected 可重掷一次(generate_character_sheet);' +
      '**连拒且 fail_hint 理由几乎相同 = 锚字段与人物档案冲突(结构性必拒),重掷纯白花钱**——' +
      '先 run_precheck 看 anchor-conflict 警告,把 visual_lock/art_bible 里钉死的角色外观移除或对齐档案再重掷。',
    { episode_id: z.number().int().positive() },
    async ({ episode_id }) => jsonResult(await client.produceGet(`/episodes/${episode_id}/characters`)),
  )
  server.tool(
    'get_scenes',
    '读某一集的场景列表(名字/描述/场景图是否就绪)。免费。',
    { episode_id: z.number().int().positive() },
    async ({ episode_id }) => jsonResult(await client.produceGet(`/episodes/${episode_id}/scenes`)),
  )
  server.tool(
    'get_assets',
    '读一部剧的全部资产聚合(角色/场景/道具/图片)。免费。',
    { drama_id: z.number().int().positive() },
    async ({ drama_id }) => jsonResult(await client.produceGet(`/dramas/${drama_id}/assets`)),
  )

  // ========== P1 · 任务进度 + 成本/预算 ==========
  server.tool(
    'get_jobs',
    '查一部剧的任务队列进度(出图/出视频/合成各阶段的 pending/processing/done/failed)。' +
      '异步生成后用它看进度。免费。',
    { drama_id: z.number().int().positive() },
    async ({ drama_id }) => jsonResult(await client.produceGet(`/dramas/${drama_id}/jobs`)),
  )
  server.tool(
    'get_cost_estimate',
    '查一部剧的整体成本预估(点数)。免费。',
    { drama_id: z.number().int().positive() },
    async ({ drama_id }) => jsonResult(await client.produceGet(`/dramas/${drama_id}/cost-estimate`)),
  )
  server.tool(
    'get_budget_status',
    '查一部剧的预算状态(预算/已花费/剩余)。免费。',
    { drama_id: z.number().int().positive() },
    async ({ drama_id }) => jsonResult(await client.produceGet(`/dramas/${drama_id}/budget-status`)),
  )

  // ========== P1 · 整集配音(成片前的强制音频步)==========
  server.tool(
    'assign_voices',
    '★给本集所有角色分配音色(配音导演 agent 按性别/性格/年龄/角色定位+项目语言选)。' +
      'voiceStyle 不是提取时自动填的——不分配,generate_tts 就没音色。文本步(LLM)后付。' +
      '后台异步,轮询 get_pipeline_status:assign_voices=done 即完成,再 generate_tts。',
    { episode_id: z.number().int().positive() },
    async ({ episode_id }) => jsonResult(await client.producePost(`/episodes/${episode_id}/assign-voices`)),
  )
  server.tool(
    'generate_tts',
    '给整集所有对白批量配音(TTS)。成片前的音频步——不配音成片会缺对白。前置:先 assign_voices 给角色分配音色。后台异步,按用量后付不欠费。',
    { episode_id: z.number().int().positive() },
    async ({ episode_id }) => jsonResult(await client.producePost(`/episodes/${episode_id}/tts`)),
  )

  // ========== P1 · MV 子流程(project_type=mv 专用)==========
  server.tool(
    'set_mv_lyrics',
    'MV 项目:设置歌词(整曲音频另在建剧时传)。免费。之后 generate_mv_story → generate_mv_script。',
    { drama_id: z.number().int().positive(), lyrics: z.string().min(1).describe('歌词全文') },
    async ({ drama_id, lyrics }) => jsonResult(await client.producePost(`/dramas/${drama_id}/mv/lyrics`, { lyrics })),
  )
  server.tool(
    'generate_mv_story',
    'MV 项目:据歌词 AI 编一个 MV 故事线。后台/同步,按用量后付。',
    { drama_id: z.number().int().positive() },
    async ({ drama_id }) => jsonResult(await client.producePost(`/dramas/${drama_id}/mv/story`)),
  )
  server.tool(
    'generate_mv_script',
    'MV 项目:据歌词+故事写首集可拍剧本(写 scriptContent)。之后走标准 extract_assets → 分镜 → …。按用量后付。',
    { drama_id: z.number().int().positive() },
    async ({ drama_id }) => jsonResult(await client.producePost(`/dramas/${drama_id}/mv/script`)),
  )
  server.tool(
    'get_mv',
    'MV 项目:读歌词/故事/剧本当前状态。免费。',
    { drama_id: z.number().int().positive() },
    async ({ drama_id }) => jsonResult(await client.produceGet(`/dramas/${drama_id}/mv`)),
  )

  // ========== P1 · 资产精修(提取后改设定再出图)==========
  server.tool(
    'update_character',
    '改角色设定(名字/外貌/年龄段/族裔/性别/性格/戏份/档案锁定)。改后需重出定妆图/相关图。免费。' +
      '★profile_locked=1:客户确认外观后锁定档案,后续 AI 提取不再覆盖外貌/性格/描述——外貌锚着定妆图与人脸锁定,被覆盖=全片换脸;确认满意即锁,要再改先传 0 解锁。',
    {
      character_id: z.number().int().positive(),
      name: z.string().optional(),
      description: z.string().optional(),
      appearance: z.string().optional().describe('外貌描述'),
      age_stage: z.string().optional(),
      ethnicity: z.string().optional(),
      gender: z.string().optional(),
      personality: z.string().optional(),
      role: z.string().optional(),
      profile_locked: z.number().int().min(0).max(1).optional().describe('1=锁定档案(AI 提取不再覆盖外貌/性格/描述,防定妆图换脸);0=解锁'),
    },
    async ({ character_id, ...fields }) => jsonResult(await client.producePut(`/characters/${character_id}`, fields)),
  )
  server.tool(
    'delete_character',
    '删除一个角色(提取误建/合并时用)。免费。',
    { character_id: z.number().int().positive() },
    async ({ character_id }) => jsonResult(await client.produceDelete(`/characters/${character_id}`)),
  )
  server.tool(
    'update_scene',
    '改场景设定(名字/描述/地点/时段/氛围)。免费。',
    {
      scene_id: z.number().int().positive(),
      name: z.string().optional(),
      description: z.string().optional(),
      location: z.string().optional(),
      physical_location: z.string().optional(),
      time_of_day: z.string().optional(),
      mood: z.string().optional(),
    },
    async ({ scene_id, ...fields }) => jsonResult(await client.producePut(`/scenes/${scene_id}`, fields)),
  )
  server.tool(
    'delete_scene',
    '删除一个场景。免费。',
    { scene_id: z.number().int().positive() },
    async ({ scene_id }) => jsonResult(await client.produceDelete(`/scenes/${scene_id}`)),
  )
  server.tool(
    'generate_character_sheet',
    '给**单个**角色出三视图设定图(镜头一致性根锚,所有镜头帧都会引用;比定妆图更完整)。整集批量用 generate_character_sheets。' +
      '前置:该角色已有定妆图。图片步,按用量后付不欠费。',
    { character_id: z.number().int().positive(), episode_id: z.number().int().positive().optional() },
    async ({ character_id, episode_id }) =>
      jsonResult(await client.producePost(`/characters/${character_id}/sheet`, episode_id ? { episode_id } : {})),
  )
  server.tool(
    'generate_prop_sheet',
    '给道具 AI 出设定图。图片步,按用量后付不欠费。',
    { prop_id: z.number().int().positive() },
    async ({ prop_id }) => jsonResult(await client.producePost(`/props/${prop_id}/generate-sheet`)),
  )

  // ========== 剧目级资产:道具库 CRUD + 色彩脚本/动作模板读取 ==========
  server.tool(
    'get_props',
    '列剧目道具库(每个道具名称/类型/描述/设定图)。★道具库≠广告商品库(add_product/list_products 是带货商品);道具库是剧目道具。免费。',
    { drama_id: z.number().int().positive() },
    async ({ drama_id }) => jsonResult(await client.produceGet(`/dramas/${drama_id}/props`)),
  )
  server.tool(
    'create_prop',
    '往道具库加一个道具。extract_assets 会自动提取道具,这里供手动补建。免费(建条目;填了 description 会自动触发出设定图、后付)。',
    {
      drama_id: z.number().int().positive(),
      name: z.string().min(1).describe('道具名'),
      type: z.string().optional().describe('类型(如 武器/信物/家具)'),
      description: z.string().optional().describe('外观描述(填了会自动触发出设定图)'),
      prompt: z.string().optional().describe('出图 prompt(可选)'),
      physical_size_hint: z.string().optional().describe('物理尺寸提示'),
      episode_id: z.number().int().positive().optional(),
    },
    async ({ drama_id, ...fields }) => jsonResult(await client.producePost(`/props`, { drama_id, ...fields })),
  )
  server.tool(
    'update_prop',
    '改道具(名称/类型/描述/prompt/尺寸/多视角参考图)。免费。',
    {
      prop_id: z.number().int().positive(),
      name: z.string().optional(),
      type: z.string().optional(),
      description: z.string().optional(),
      prompt: z.string().optional(),
      physical_size_hint: z.string().optional(),
      // v0.9.976 — 多视角/细节参考图（整份覆盖；传 [] 清空，最多 6 张 http(s) 图）。
      // 与主图分工：主图锁「这是什么」，多视角锁「截面与部件怎么装配」——单张白底图
      // 和文字都表达不了这个（生产实证：形制文本已送达，锤头仍画成被禁的形状）。
      // 正视 / 侧视 / 端面各一张最有效，端面是截面形状唯一能说清的方式。
      reference_images: z.array(z.string().url()).max(6).optional()
        .describe('多视角参考图 URL 数组，整份覆盖；建议正视/侧视/端面各一张'),
    },
    async ({ prop_id, ...fields }) => jsonResult(await client.producePut(`/props/${prop_id}`, fields)),
  )
  server.tool(
    'delete_prop',
    '删一个道具。免费。',
    { prop_id: z.number().int().positive() },
    async ({ prop_id }) => jsonResult(await client.produceDelete(`/props/${prop_id}`)),
  )
  server.tool(
    'mark_signature_prop',
    '标记/取消「招牌道具」(会在多镜复现的关键道具,加强一致性追踪)。signature=false 取消。免费。',
    { prop_id: z.number().int().positive(), signature: z.boolean().optional().describe('默认 true 标记;false 取消') },
    async ({ prop_id, signature }) => jsonResult(await client.producePost(`/props/${prop_id}/signature`, { signature: signature !== false })),
  )
  server.tool(
    'get_color_scripts',
    '读该剧已生成的色彩脚本(全片配色情绪)。generate_color_script 生成、此工具读取。免费。',
    { drama_id: z.number().int().positive() },
    async ({ drama_id }) => jsonResult(await client.produceGet(`/dramas/${drama_id}/color-scripts`)),
  )
  server.tool(
    'get_motion_templates',
    '读该剧已有的动作模板(运镜/动作预设)。generate_motion_templates 生成、此工具读取。免费。',
    { drama_id: z.number().int().positive() },
    async ({ drama_id }) => jsonResult(await client.produceGet(`/dramas/${drama_id}/motion-templates`)),
  )

  // ========== P2 · 连续性 / 场景组 / 多画幅 ==========
  server.tool(
    'chain_frames',
    '整集首尾帧接力链:让每镜首帧承接上镜尾帧,镜间画面连续(比各镜独立出帧更顺)。按用量后付。',
    { episode_id: z.number().int().positive() },
    async ({ episode_id }) => jsonResult(await client.producePost(`/episodes/${episode_id}/chain-frames`)),
  )
  server.tool(
    'get_scene_group_plan',
    '查某一集的场景组规划(镜头如何归组做连续长镜)。免费。',
    { episode_id: z.number().int().positive() },
    async ({ episode_id }) => jsonResult(await client.produceGet(`/episodes/${episode_id}/scene-group-plan`)),
  )
  server.tool(
    'generate_scene_groups',
    '生成场景组(把连续镜头归组,连续长镜/批量出图的地基)。后台异步。',
    { episode_id: z.number().int().positive() },
    async ({ episode_id }) => jsonResult(await client.producePost(`/episodes/${episode_id}/scene-groups`)),
  )
  server.tool(
    'render_multi_aspect',
    '把成片按多个画幅(竖/横/方)重渲一版,便于多平台分发。免费(纯 ffmpeg),后台异步。',
    {
      episode_id: z.number().int().positive(),
      aspects: z.array(z.enum(['9:16', '16:9', '1:1', '4:5'])).optional().describe('目标画幅集'),
    },
    async ({ episode_id, aspects }) =>
      jsonResult(await client.producePost(`/episodes/${episode_id}/render-multi-aspect`, aspects ? { aspects } : {})),
  )

  // ========== P2 · 口型 / 海报封面 ==========
  server.tool(
    'lipsync_shot',
    '给单镜做口型同步(对白与人物嘴型对齐)。按用量后付。',
    { storyboard_id: z.number().int().positive() },
    async ({ storyboard_id }) => jsonResult(await client.producePost(`/storyboards/${storyboard_id}/lipsync`)),
  )
  server.tool(
    'lipsync_episode',
    '给整集批量口型同步。后台异步,按用量后付。用 get_lipsync_status 查进度。',
    { episode_id: z.number().int().positive() },
    async ({ episode_id }) => jsonResult(await client.producePost(`/episodes/${episode_id}/lipsync-batch`)),
  )
  server.tool(
    'get_lipsync_status',
    '查整集口型同步进度。免费。',
    { episode_id: z.number().int().positive() },
    async ({ episode_id }) => jsonResult(await client.produceGet(`/episodes/${episode_id}/lipsync-status`)),
  )
  server.tool(
    'generate_episode_poster',
    '给某一集生成海报图。图片步,按用量后付。',
    { episode_id: z.number().int().positive() },
    async ({ episode_id }) => jsonResult(await client.producePost(`/episodes/${episode_id}/poster`)),
  )
  server.tool(
    'generate_drama_poster',
    '给整部剧生成海报图(KV)。图片步,按用量后付。',
    { drama_id: z.number().int().positive() },
    async ({ drama_id }) => jsonResult(await client.producePost(`/dramas/${drama_id}/poster`)),
  )
  server.tool(
    'generate_cover',
    '给整部剧生成片头封面图。图片步,按用量后付。',
    { drama_id: z.number().int().positive() },
    async ({ drama_id }) => jsonResult(await client.producePost(`/dramas/${drama_id}/cover`)),
  )

  // ========== P2 · 音效 / 特效 / 转场 ==========
  server.tool(
    'generate_sfx',
    '给整集自动匹配+生成音效(SFX)。后台异步,按用量后付。',
    { episode_id: z.number().int().positive() },
    async ({ episode_id }) => jsonResult(await client.producePost(`/episodes/${episode_id}/sfx`)),
  )
  server.tool(
    'generate_effects',
    '给整集自动匹配视觉特效。后台异步,按用量后付。',
    { episode_id: z.number().int().positive() },
    async ({ episode_id }) => jsonResult(await client.producePost(`/episodes/${episode_id}/effects`)),
  )
  server.tool(
    'generate_transitions',
    '给整集自动加转场(闪白/玻璃碎裂等)。后台异步。',
    { episode_id: z.number().int().positive() },
    async ({ episode_id }) => jsonResult(await client.producePost(`/episodes/${episode_id}/transitions`)),
  )

  // ========== P2 · 品牌片交付物 / 广告商品库 ==========
  server.tool(
    'get_deliverables',
    '品牌片:读交付物树(海报/母版/分轨/各平台版等)。免费。',
    { drama_id: z.number().int().positive() },
    async ({ drama_id }) => jsonResult(await client.produceGet(`/dramas/${drama_id}/deliverables`)),
  )
  server.tool(
    'generate_deliverables',
    '品牌片:一键生成全部交付物。后台异步,按用量后付。',
    { drama_id: z.number().int().positive() },
    async ({ drama_id }) => jsonResult(await client.producePost(`/dramas/${drama_id}/deliverables`)),
  )
  server.tool(
    'add_product',
    '★广告项目必做:往商品库加一个商品(名称/卖点/图),是广告的**主体**——出视频时按分镜文本匹配产品图当锚,' +
      '不建产品库镜头里的产品会漂移/瞎编。建完用 generate_product_sheet 出设定图(锚更稳)。免费(仅建条目)。',
    {
      drama_id: z.number().int().positive(),
      name: z.string().min(1),
      description: z.string().optional().describe('卖点/描述'),
      image_url: z.string().optional().describe('商品图 URL(先 upload_image 拿)'),
    },
    async ({ drama_id, ...fields }) => jsonResult(await client.producePost(`/dramas/${drama_id}/products`, fields)),
  )
  server.tool(
    'list_products',
    '广告项目:列出商品库。免费。',
    { drama_id: z.number().int().positive() },
    async ({ drama_id }) => jsonResult(await client.produceGet(`/dramas/${drama_id}/products`)),
  )
  server.tool(
    'generate_product_sheet',
    '★广告项目:给商品库里某商品 AI 出设定图(广告露出锚)。商品无设定图 → 出视频时按分镜 grep 产品名取图当锚会落空、产品漂移。图片步,按用量后付不欠费。',
    { product_id: z.number().int().positive() },
    async ({ product_id }) => jsonResult(await client.producePost(`/products/${product_id}/sheet`)),
  )

  // ========== AI 声音克隆(voice cloning)==========
  // 音色是**独立资产**:克隆 → 试听下载,全程不需要角色。绑角色只是「要出片」时的
  // 可选下游动作。voice_id 形如 `lib:12`,克隆/列表/试听/绑定四处同一命名空间。
  server.tool(
    'clone_voice',
    '从一段**已授权**的音频样本克隆音色,返回 voice_id。**不需要先有角色或剧目**。' +
      '⚠️ 样本必须是本人/持权人**同意授权**的声音(否则侵权,与真人/版权门同理)。' +
      '样本会自动转写出配套文本(零样本克隆需要),10 秒左右清晰人声即可,别用纯音乐/静音。' +
      '按平台价计费(每个音色一口价)。克隆完可直接 speak_with_voice 试听下载;' +
      '只有要用它配音出片时,才需要再 set_character_voice 绑到角色。',
    {
      name: z.string().min(1).describe('音色命名(便于管理)'),
      sample_file_path: z.string().optional().describe('本地授权音频样本路径(mp3/wav/m4a,自动上传;与 sample_url 二选一)'),
      sample_url: z.string().optional().describe('已上传到 COS 的样本 URL(与 sample_file_path 二选一)'),
      notes: z.string().optional().describe('备注(可选)'),
    },
    async ({ name, sample_file_path, sample_url, notes }) => {
      let url = sample_url
      if (!url && sample_file_path) url = await client.uploadLocalFile(sample_file_path, 'audio')
      if (!url) throw new Error('需要 sample_file_path(本地样本自动上传)或 sample_url(已上传的 URL)')
      return jsonResult(await client.producePost('/voice-clones', notes ? { name, sample_url: url, notes } : { name, sample_url: url }))
    },
  )
  server.tool(
    'speak_with_voice',
    '让某个音色说一段任意文本,返回可下载的音频 URL。**不需要角色、不需要剧目**——' +
      '克隆完先用它验收音色像不像,或直接把音频拿去别处用。按文本长度计费(tts 档)。',
    {
      voice_id: z.string().describe('来自 clone_voice / list_voices 的 voice_id(形如 lib:12)'),
      text: z.string().min(1).max(500).describe('要让这个音色说的话(上限 500 字)'),
    },
    async ({ voice_id, text }) => {
      const id = String(voice_id).replace(/^lib:/, '')
      return jsonResult(await client.producePost(`/voice-clones/${id}/speak`, { text }))
    },
  )
  server.tool(
    'list_voices',
    '列出可用音色:我克隆的私有音色 + 平台公共音色(voice_id/名字/试听样本)。免费。',
    {},
    async () => jsonResult(await client.produceGet('/voice-clones')),
  )
  server.tool(
    'delete_voice',
    '删除我音色库里的一个克隆音色(平台公共音色不可删)。免费。',
    { voice_id: z.string().describe('形如 lib:12') },
    async ({ voice_id }) => jsonResult(await client.produceDelete(`/voice-clones/${String(voice_id).replace(/^lib:/, '')}`)),
  )
  server.tool(
    'set_character_voice',
    '把音色绑到某角色,之后 generate_tts 用它给该角色配音。免费。' +
      '只有要出片时才需要这步——克隆和试听都不需要角色。',
    {
      character_id: z.number().int().positive(),
      voice_id: z.string().describe('来自 clone_voice / list_voices 的 voice_id(形如 lib:12)'),
    },
    async ({ character_id, voice_id }) =>
      jsonResult(await client.producePost(`/characters/${character_id}/voice`, { voice_id })),
  )

  // ── 素材交接包：客户自己拼片的通道 ──────────────────────────────────────
  // 与 compose_episode 的分工：compose_episode = 「平台替你拼」；本组工具 = 「素材给你，
  // 你自己决定转场、自己拼」。两条路都不丢客户的对白/音效/配乐/字幕成果。
  server.tool(
    'export_handoff_pack',
    '导出本集「素材交接包」清单:逐镜裸片 + 对白音轨 + 音效 + 配乐 + 字幕的可下载 URL,' +
      '交给你在**自己那边**完成转场决策、拼接、混音、烧字幕——平台不参与终拼。免费,零扣费。\n' +
      '\n【推荐流程】① 调本工具拿 manifest;② 按 clips[].url 把裸片下载到本地;' +
      '③ 你自己看片判断每个接缝该用什么转场(manifest 给了 scene_boundary 场景边界作判据),' +
      '写一份 plan.json;④ 用 get_handoff_toolchain 拿到 compile_timeline.py 展开时间轴、' +
      'assemble.sh 装配出成片。工具链已经把「加了重叠转场之后字幕/对白/音效怎么跟着位移」算好了。\n' +
      '\n【三个不看就会翻车的事实】\n' +
      '① audio_contract.mode="tts" 时**裸片里没有人声**,对白在 dialogue_audio 里;不铺就是整集没台词。' +
      'mode="clip" 时人声已烤在裸片音轨里,反过来**不要**再叠。\n' +
      '② 每镜必须按 trim_head_ms / duration_ms 裁剪再用;直接拼整条裸片会把平台已经 QC 掉的' +
      '首尾形变帧一起拼进去。\n' +
      '③ 字幕 cue、dialogue_audio.offset_ms、sfx[].offset_ms 的基准都是「该镜 trim 之后的第 0 毫秒」,' +
      '不是成片绝对时间。你加多少重叠转场都不用改它们——交给 compile_timeline.py 展开,别手算累加。\n' +
      '\n想让平台代拼、要平台级质量闸(终拼预检/音画等长/响度母带),改用 compose_episode。',
    { episode_id: z.number().int().positive() },
    async ({ episode_id }) => {
      const manifest: any = await client.produceGet(`/episodes/${episode_id}/handoff-pack`)
      return jsonResult({
        ...manifest,
        assembly_guide: {
          step_1_download:
            '按 shots[].clip.url / dialogue_audio.url / sfx[].url / bgm[].url 下载素材。' +
            'URL 到 expires_at 失效,过期重新调本工具。',
          step_2_decide_transitions:
            '自己分析画面决定每个接缝的转场。scene_boundary="start" 是换场(适合给转场),' +
            '"continue" 是同场景(平台默认硬切——同场景逐镜叠化是"幻灯片拼凑感"的主因)。' +
            'transition_hint 是平台建议,你可以覆盖。',
          step_3_plan_json:
            '写 plan.json:{"transitions":[{"before_shot":3,"type":"fade","overlap_ms":300}]}。' +
            'type 接受预设 id(fade/flash_white/whip_pan…)、导演语义键' +
            '(match_cut/smash_cut/cross_dissolve…)、或直接给 ffmpeg xfade 名。' +
            'overlap_ms 不填就用该预设的规范时长。',
          step_4_assemble:
            'save_handoff_toolchain 把三个脚本落到本地目录,然后:\n' +
            '  python3 fetch_pack.py manifest.json -o ./pack   # 下载素材 + 内联字幕落成 SRT\n' +
            '  python3 compile_timeline.py ./pack --transitions plan.json\n' +
            '  ./assemble.sh ./pack out.mp4 plan.json',
          gotchas: [
            'clip.duration_source="authored" 的镜是 probe 失败退回声明时长的,请自行 ffprobe 校正,否则拼接有累积误差。',
            'render_target.color_lut 非 null 时,裸片是**未调色**的:必须施加随包的 haldclut 查找表,' +
              '否则你的成片与平台成片有色差。fetch_pack.py 会下载它、assemble.sh 会自动施加。',
            '重叠转场会让其后所有镜整体前移且误差累积——用 compile_timeline.py 算,不要手算。',
            '闪白/闪黑(flash_white/flash_black)是硬切+片头闪光,不能走 xfade,否则双重闪且破坏口型。工具链已处理。',
            '响度必须两 pass 线性母带;单 pass 动态 loudnorm 会把对白间隙的 BGM 上提,让配乐增益调了等于没调。',
            '侧链避让的 key 必须是纯人声轨,混进音效会让打击音也把 BGM 压下去,听感是配乐一惊一乍。',
          ],
          toolchain:
            'save_handoff_toolchain 直接把工具链写到你的工作目录(推荐);或 get_handoff_toolchain 拿源码自己保存。',
        },
      })
    },
  )
  server.tool(
    'get_handoff_toolchain',
    '拿到素材交接包的装配工具链源码(compile_timeline.py 时间轴编译器 / assemble.sh ffmpeg 装配脚本)。' +
      '免费。本工具只返回源码文本,**不会**在你机器上写文件——请自行保存到工作目录再执行。\n' +
      'compile_timeline.py 负责把「镜相对」的字幕/对白/音效锚点展开成你自己时间轴上的绝对时间码,' +
      '并处理重叠转场引起的整体位移;assemble.sh 是从裸片到成片的完整 ffmpeg 装配基线' +
      '(裁剪→规范化→拼接/xfade→配乐侧链→字幕→两 pass 母带)。' +
      '依赖 ffmpeg(烧字幕需带 libass)、ffprobe、jq、python3。',
    {
      script: z.enum([...TOOLCHAIN_FILENAMES, 'all']).optional().describe('要哪个;缺省 all'),
    },
    async ({ script }) => {
      const want = script && script !== 'all' ? [script] : [...TOOLCHAIN_FILENAMES]
      const files: Record<string, string> = {}
      for (const f of want) {
        try {
          files[f] = readFileSync(join(HANDOFF_ASSETS, f), 'utf8')
        } catch (e: any) {
          files[f] = `// 读取失败: ${e?.message || e}`
        }
      }
      return jsonResult({ files, usage: TOOLCHAIN_USAGE, note: TOOLCHAIN_NOTE })
    },
  )
  server.tool(
    'save_handoff_toolchain',
    '把装配工具链(fetch_pack.py / compile_timeline.py / assemble.sh)直接写到你本地的一个目录,' +
      '省掉自己复制粘贴。免费。目录必须**已存在**且是绝对路径;文件名固定,不接受自定义。\n' +
      '拒绝写入隐藏目录(~/.ssh、~/.config、.git…)与系统目录——这是写盘不是读盘,覆盖错地方不可逆。\n' +
      '落盘后完整流程:\n' +
      '  python3 fetch_pack.py manifest.json -o ./pack   # 下载素材、内联字幕落成 SRT\n' +
      '  python3 compile_timeline.py ./pack [--transitions plan.json]\n' +
      '  ./assemble.sh ./pack out.mp4 [plan.json]',
    { dir: z.string().describe('已存在的绝对路径目录,如 /Users/me/work/starreel-pack') },
    async ({ dir }) => {
      const safe = assertSafeToolchainDir(dir)
      const written: Array<{ file: string; bytes: number; mode: string }> = []
      for (const f of TOOLCHAIN_FILENAMES) {
        const body = readFileSync(join(HANDOFF_ASSETS, f), 'utf8')
        const dest = join(safe, f)
        writeFileSync(dest, body, 'utf8')
        // .sh 要可执行,否则第三方还得自己 chmod 一次才跑得起来
        if (f.endsWith('.sh')) chmodSync(dest, 0o755)
        written.push({ file: dest, bytes: Buffer.byteLength(body), mode: f.endsWith('.sh') ? '0755' : '0644' })
      }
      return jsonResult({ written, usage: TOOLCHAIN_USAGE, note: TOOLCHAIN_NOTE })
    },
  )
}
