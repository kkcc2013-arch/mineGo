// frontend/game-client/src/accessibility/strings.js
// 无障碍播报 / 字幕 / 语音反馈的多语言文案（zh-CN / en-US / ja-JP / ko-KR，RTL 语言回退英文）

const S = {
  'zh-CN': {
    cue_battle_action: '战斗动作', cue_battle_hit: '命中', cue_battle_faint: '倒下', cue_battle_win: '战斗胜利', cue_battle_lose: '战斗失败',
    cap_battle_action: '[技能释放音效]', cap_battle_hit: '[命中的撞击声]', cap_battle_faint: '[精灵倒下的声音]', cap_battle_win: '[胜利号角]', cap_battle_lose: '[失败的低沉音效]',
    screen_login: '登录页面', screen_map: '地图页面', screen_catch: '捕捉页面', screen_profile: '我的页面',
    entered: '已进入{screen}',
    nearby_none: '附近暂无精灵',
    nearby_summary: '附近有 {count} 只精灵{nearest}；{stops} 个补给站，{gyms} 个道馆',
    nearest: '，最近的是{name}，{dir}方向约 {dist} 米',
    spawn_new: '新精灵出现：{name}，{dir}方向约 {dist} 米',
    catch_open: '遭遇野生{name}，CP {cp}。按 1 2 3 选择精灵球，按 T 投球，按 V 听取详细描述',
    catch_success: '捕捉成功',
    catch_fled: '精灵逃跑了',
    catch_escape: '精灵挣脱了，再试一次',
    catch_miss: '没有命中',
    throw_rating: '投球评价：{rating}',
    ball_selected: '已选择{ball}',
    item_pickup: '获得道具',
    speed_badge: '速度 {x} 倍',
    pace_competitive: 'PVP / 竞技模式下节奏控制与辅助已禁用',
    motor_on: '动作辅助已开启', motor_off: '动作辅助已关闭',
    anim_stopped: '已紧急停止所有动画', anim_resumed: '动画已恢复',
    gamepad_on: '已连接手柄：{name}', gamepad_off: '手柄已断开：{name}',
    voice_listening: '语音控制已开启，请说出指令', voice_stopped: '语音控制已关闭',
    voice_done: '已执行：{action}', voice_unknown: '没有听懂：{text}',
    shortcut_done: '{action}',
    settings_opened: '无障碍设置已打开', dialog_closed: '已关闭',
    break_reminder: '已经连续游玩一段时间了，建议休息一下',
    fatigue: '已连续投球 {n} 次，建议休息片刻',
    change_warning: '即将返回地图',
    best_moment: '最佳时机',
    cap_spawn: '[精灵出现的声音]', cap_catch_success: '[捕捉成功的欢快音效]', cap_catch_fail: '[精灵逃走的声音]',
    cap_catch_escape: '[精灵球晃动后弹开]', cap_throw: '[投掷精灵球]', cap_warning: '[警告提示音]', cap_ui: '[提示音]',
    cap_item: '[获得道具的音效]', cap_battle: '[战斗开始的音效]', cap_social: '[消息提示音]',
    cue_spawn: '精灵出现', cue_catch_success: '捕捉成功', cue_catch_fail: '精灵逃跑', cue_catch_escape: '挣脱',
    cue_throw: '投球', cue_warning: '警告', cue_ui: '提示', cue_item: '获得道具', cue_battle: '战斗开始', cue_social: '消息',
    dir: ['北', '东北', '东', '东南', '南', '西南', '西', '西北'],
    balls: { POKE_BALL: '普通球', GREAT_BALL: '超级球', ULTRA_BALL: '高级球' },
  },
  'en-US': {
    cue_battle_action: 'Battle move', cue_battle_hit: 'Hit', cue_battle_faint: 'Fainted', cue_battle_win: 'Victory', cue_battle_lose: 'Defeat',
    cap_battle_action: '[Move sound]', cap_battle_hit: '[Impact]', cap_battle_faint: '[Pokémon faints]', cap_battle_win: '[Victory fanfare]', cap_battle_lose: '[Defeat sound]',
    screen_login: 'Login', screen_map: 'Map', screen_catch: 'Catch', screen_profile: 'Profile',
    entered: '{screen} screen',
    nearby_none: 'No Pokémon nearby',
    nearby_summary: '{count} Pokémon nearby{nearest}; {stops} PokéStops, {gyms} gyms',
    nearest: ', nearest is {name}, about {dist} meters {dir}',
    spawn_new: 'New Pokémon: {name}, about {dist} meters {dir}',
    catch_open: 'Wild {name} appeared, CP {cp}. Press 1 2 3 to choose a ball, T to throw, V for a description',
    catch_success: 'Caught!', catch_fled: 'The Pokémon fled', catch_escape: 'It broke free, try again', catch_miss: 'Missed',
    throw_rating: 'Throw: {rating}', ball_selected: '{ball} selected', item_pickup: 'Item received',
    speed_badge: 'Speed {x}x', pace_competitive: 'Pace control and assists are disabled in PVP / competitive modes',
    motor_on: 'Motor assist on', motor_off: 'Motor assist off',
    anim_stopped: 'All animations stopped', anim_resumed: 'Animations resumed',
    gamepad_on: 'Controller connected: {name}', gamepad_off: 'Controller disconnected: {name}',
    voice_listening: 'Voice control on, say a command', voice_stopped: 'Voice control off',
    voice_done: 'Done: {action}', voice_unknown: 'Did not understand: {text}',
    shortcut_done: '{action}', settings_opened: 'Accessibility settings opened', dialog_closed: 'Closed',
    break_reminder: 'You have been playing for a while. Consider taking a break',
    fatigue: '{n} throws in a row. Consider a short rest', change_warning: 'Returning to the map', best_moment: 'Best moment',
    cap_spawn: '[Pokémon appears]', cap_catch_success: '[Happy catch jingle]', cap_catch_fail: '[Pokémon runs away]',
    cap_catch_escape: '[Ball wobbles and pops open]', cap_throw: '[Ball thrown]', cap_warning: '[Warning beep]', cap_ui: '[Notification]',
    cap_item: '[Item chime]', cap_battle: '[Battle starts]', cap_social: '[Message chime]',
    cue_spawn: 'Pokémon appeared', cue_catch_success: 'Caught', cue_catch_fail: 'Fled', cue_catch_escape: 'Broke free',
    cue_throw: 'Throw', cue_warning: 'Warning', cue_ui: 'Notice', cue_item: 'Item', cue_battle: 'Battle', cue_social: 'Message',
    dir: ['north', 'north-east', 'east', 'south-east', 'south', 'south-west', 'west', 'north-west'],
    balls: { POKE_BALL: 'Poké Ball', GREAT_BALL: 'Great Ball', ULTRA_BALL: 'Ultra Ball' },
  },
  'ja-JP': {
    cue_battle_action: 'わざ', cue_battle_hit: '命中', cue_battle_faint: 'ひんし', cue_battle_win: '勝利', cue_battle_lose: '敗北',
    cap_battle_action: '［わざの効果音］', cap_battle_hit: '［命中音］', cap_battle_faint: '［ひんしの音］', cap_battle_win: '［勝利のファンファーレ］', cap_battle_lose: '［敗北の音］',
    screen_login: 'ログイン', screen_map: 'マップ', screen_catch: '捕獲', screen_profile: 'マイページ',
    entered: '{screen}画面',
    nearby_none: '近くにポケモンはいません',
    nearby_summary: '近くにポケモンが {count} 匹{nearest}。ポケストップ {stops}、ジム {gyms}',
    nearest: '、一番近いのは{name}、{dir}に約 {dist} メートル',
    spawn_new: '新しいポケモン：{name}、{dir}に約 {dist} メートル',
    catch_open: '野生の{name}が現れた、CP {cp}。1 2 3 でボール選択、T で投げる、V で説明',
    catch_success: '捕まえた！', catch_fled: '逃げられた', catch_escape: '飛び出した、もう一度', catch_miss: '外れた',
    throw_rating: '評価：{rating}', ball_selected: '{ball}を選択', item_pickup: 'アイテム入手',
    speed_badge: '速度 {x} 倍', pace_competitive: '対戦モードではペース調整とアシストは無効です',
    motor_on: '操作アシスト オン', motor_off: '操作アシスト オフ',
    anim_stopped: 'すべてのアニメーションを停止しました', anim_resumed: 'アニメーションを再開しました',
    gamepad_on: 'コントローラー接続：{name}', gamepad_off: 'コントローラー切断：{name}',
    voice_listening: '音声操作オン、コマンドをどうぞ', voice_stopped: '音声操作オフ',
    voice_done: '実行：{action}', voice_unknown: '認識できません：{text}',
    shortcut_done: '{action}', settings_opened: 'アクセシビリティ設定を開きました', dialog_closed: '閉じました',
    break_reminder: '長時間プレイしています。休憩しましょう',
    fatigue: '{n} 回連続で投げました。少し休みましょう', change_warning: 'マップに戻ります', best_moment: 'ベストタイミング',
    cap_spawn: '［ポケモン出現音］', cap_catch_success: '［捕獲成功のジングル］', cap_catch_fail: '［逃げる音］',
    cap_catch_escape: '［ボールが揺れて開く音］', cap_throw: '［ボールを投げる音］', cap_warning: '［警告音］', cap_ui: '［通知音］',
    cap_item: '［アイテム入手音］', cap_battle: '［バトル開始音］', cap_social: '［メッセージ音］',
    cue_spawn: 'ポケモン出現', cue_catch_success: '捕獲成功', cue_catch_fail: '逃走', cue_catch_escape: '脱出',
    cue_throw: '投球', cue_warning: '警告', cue_ui: '通知', cue_item: 'アイテム', cue_battle: 'バトル', cue_social: 'メッセージ',
    dir: ['北', '北東', '東', '南東', '南', '南西', '西', '北西'],
    balls: { POKE_BALL: 'モンスターボール', GREAT_BALL: 'スーパーボール', ULTRA_BALL: 'ハイパーボール' },
  },
  'ko-KR': {
    cap_spawn: '[포켓몬 등장 소리]', cap_catch_success: '[포획 성공 효과음]', cap_catch_fail: '[포켓몬이 도망가는 소리]',
    cap_catch_escape: '[볼이 흔들리다 열림]', cap_throw: '[볼 던지기]', cap_warning: '[경고음]', cap_ui: '[알림음]',
    cap_item: '[아이템 획득음]', cap_battle: '[배틀 시작]', cap_social: '[메시지 알림]',
  },
};

export const SUPPORTED_SPEECH_LANGS = ['zh-CN', 'en-US', 'ja-JP'];

export function resolveLang(lang) {
  const l = String(lang || '').toLowerCase();
  if (l.startsWith('zh')) return 'zh-CN';
  if (l.startsWith('ja')) return 'ja-JP';
  if (l.startsWith('ko')) return 'ko-KR';
  if (l.startsWith('en')) return 'en-US';
  if (!l) return 'zh-CN';
  return 'en-US'; // 其他语言（含 ar/he 等 RTL）回退英文
}

/** t('entered', 'zh-CN', { screen: '地图' }) */
export function t(key, lang, params = {}) {
  const L = resolveLang(lang);
  const table = S[L] || S['en-US'];
  let v = table[key];
  if (v === undefined) v = (S['en-US'][key] !== undefined ? S['en-US'][key] : S['zh-CN'][key]);
  if (typeof v !== 'string') return v;
  return v.replace(/\{(\w+)\}/g, (_, k) => (params[k] === undefined ? '' : String(params[k])));
}

export function currentLang() {
  if (typeof document === 'undefined') return 'zh-CN';
  return document.documentElement.lang || 'zh-CN';
}
