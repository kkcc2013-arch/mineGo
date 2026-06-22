# REQ-00286: 游戏认知障碍支持与简化模式系统

## 元信息
| 字段 | 值 |
|------|-----|
| 编号 | REQ-00286 |
| 标题 | 游戏认知障碍支持与简化模式系统 |
| 类别 | 无障碍(a11y) |
| 优先级 | P1 |
| 状态 | new |
| 涉及服务 | game-client, user-service, pokemon-service, backend/shared |
| 创建时间 | 2026-06-22 08:00 |

## 需求描述

为认知障碍玩家（包括阅读障碍、注意力缺陷多动障碍ADHD、自闭症谱系障碍ASD、老年认知衰退等）提供游戏简化模式和辅助功能，确保游戏对更广泛人群的可访问性。符合 WCAG 2.1 AAA 级认知功能标准及游戏行业无障碍指南（Game Accessibility Guidelines）。

### 核心目标
1. **简化模式**：一键启用简化界面，减少认知负担
2. **阅读辅助**：为阅读障碍玩家提供文字转语音、字体优化
3. **注意力管理**：为 ADHD 玩家提供减少干扰、聚焦核心任务的功能
4. **社交辅助**：为自闭症谱系玩家提供社交互动简化选项
5. **记忆辅助**：为认知衰退玩家提供任务提示、位置记忆

### 目标用户群体
- **阅读障碍（Dyslexia）**：约 10% 人口
- **ADHD**：约 5-7% 人口
- **自闭症谱系（ASD）**：约 1-2% 人口
- **老年认知衰退**：60 岁以上玩家群体
- **学习障碍**：认知发育迟缓玩家

## 技术方案

### 1. 简化模式引擎

```go
// backend/shared/cognitive/simplified_mode.go
package cognitive

import (
    "context"
    "encoding/json"
    "time"
)

// SimplifiedModeConfig 简化模式配置
type SimplifiedModeConfig struct {
    UserID              string              `json:"user_id"`
    Enabled             bool                `json:"enabled"`
    Profile             CognitiveProfile    `json:"profile"`
    UISimplification    UISimplification    `json:"ui_simplification"`
    GameplaySimplification GameplaySimplification `json:"gameplay_simplification"`
    SocialSimplification   SocialSimplification   `json:"social_simplification"`
    TimeLimit            *TimeLimitConfig    `json:"time_limit,omitempty"`
    createdAt            time.Time           `json:"created_at"`
    UpdatedAt            time.Time           `json:"updated_at"`
}

// CognitiveProfile 认知障碍类型配置
type CognitiveProfile struct {
    Dyslexia         bool `json:"dyslexia"`          // 阅读障碍
    ADHD             bool `json:"adhd"`              // 注意力缺陷
    AutismSpectrum   bool `json:"autism_spectrum"`   // 自闭症谱系
    CognitiveDecline bool `json:"cognitive_decline"` // 认知衰退
    LearningDisability bool `json:"learning_disability"` // 学习障碍
}

// UISimplification UI 简化选项
type UISimplification struct {
    ReduceAnimations     bool `json:"reduce_animations"`      // 减少动画
    SimplifyNavigation   bool `json:"simplify_navigation"`    // 简化导航
    HideNonEssentialUI   bool `json:"hide_non_essential_ui"`  // 隐藏非必要UI
    LargerButtons        bool `json:"larger_buttons"`         // 更大按钮
    SimplifyText         bool `json:"simplify_text"`          // 简化文字
    ConsistentLayout     bool `json:"consistent_layout"`      // 固定布局
    ReduceVisualClutter  bool `json:"reduce_visual_clutter"`  // 减少视觉干扰
    HighContrastBorders  bool `json:"high_contrast_borders"`  // 高对比度边框
}

// GameplaySimplification 游戏玩法简化
type GameplaySimplification struct {
    ExtendedTimeLimits     bool    `json:"extended_time_limits"`      // 延长时间限制
    TimeMultiplier         float64 `json:"time_multiplier"`           // 时间倍率（如 1.5x）
    PauseEnabled           bool    `json:"pause_enabled"`             // 允许暂停
    ReducedDecisionPoints  bool    `json:"reduced_decision_points"`   // 减少决策点
    AutoSaveFrequency      int     `json:"auto_save_frequency"`       // 自动保存频率（分钟）
    HintsEnabled           bool    `json:"hints_enabled"`             // 启用提示
    StepByStepGuidance     bool    `json:"step_by_step_guidance"`     // 步骤引导
    MemoryAssistance       bool    `json:"memory_assistance"`         // 记忆辅助
    SimplifyBattleUI       bool    `json:"simplify_battle_ui"`        // 简化战斗界面
    AutoSelectRecommended  bool    `json:"auto_select_recommended"`   // 自动选择推荐
}

// SocialSimplification 社交简化选项
type SocialSimplification struct {
    HideChatEmojis      bool `json:"hide_chat_emojis"`       // 隐藏聊天表情
    SimplifyChat        bool `json:"simplify_chat"`          // 简化聊天
    ReduceNotifications bool `json:"reduce_notifications"`   // 减少通知
    PreWrittenResponses bool `json:"pre_written_responses"`  // 预设回复
    HideStrangerInteractions bool `json:"hide_stranger_interactions"` // 隐藏陌生人互动
    SocialCueAssistance bool `json:"social_cue_assistance"`  // 社交提示辅助
}

// TimeLimitConfig 时间限制配置（防止游戏成瘾）
type TimeLimitConfig struct {
    DailyLimit       time.Duration `json:"daily_limit"`       // 每日限制
    SessionLimit     time.Duration `json:"session_limit"`     // 单次限制
    BreakReminder    time.Duration `json:"break_reminder"`    // 休息提醒间隔
    AutoSaveOnLimit  bool          `json:"auto_save_on_limit"` // 达到限制自动保存
}

// SimplifiedModeService 简化模式服务
type SimplifiedModeService struct {
    repo        SimplifiedModeRepository
    ttsService  *TTSService
    hintService *HintService
}

func (s *SimplifiedModeService) GetOrCreateConfig(ctx context.Context, userID string) (*SimplifiedModeConfig, error) {
    config, err := s.repo.GetByUserID(ctx, userID)
    if err == nil {
        return config, nil
    }
    
    // 创建默认配置
    config = &SimplifiedModeConfig{
        UserID:   userID,
        Enabled:  false,
        Profile:  CognitiveProfile{},
        UISimplification: UISimplification{
            LargerButtons:       true,
            ConsistentLayout:    true,
            HighContrastBorders: true,
        },
        GameplaySimplification: GameplaySimplification{
            ExtendedTimeLimits: true,
            TimeMultiplier:     1.5,
            PauseEnabled:       true,
            AutoSaveFrequency:  5,
            HintsEnabled:       true,
        },
        SocialSimplification: SocialSimplification{
            PreWrittenResponses: true,
        },
        CreatedAt: time.Now(),
        UpdatedAt: time.Now(),
    }
    
    if err := s.repo.Create(ctx, config); err != nil {
        return nil, err
    }
    
    return config, nil
}

func (s *SimplifiedModeService) UpdateConfig(ctx context.Context, userID string, updates map[string]interface{}) error {
    config, err := s.GetOrCreateConfig(ctx, userID)
    if err != nil {
        return err
    }
    
    // 应用更新
    if profile, ok := updates["profile"].(CognitiveProfile); ok {
        config.Profile = profile
        s.applyProfileDefaults(config)
    }
    
    config.UpdatedAt = time.Now()
    return s.repo.Update(ctx, config)
}

// applyProfileDefaults 根据认知障碍类型应用默认设置
func (s *SimplifiedModeService) applyProfileDefaults(config *SimplifiedModeConfig) {
    if config.Profile.Dyslexia {
        config.UISimplification.SimplifyText = true
        config.UISimplification.LargerButtons = true
    }
    
    if config.Profile.ADHD {
        config.UISimplification.ReduceAnimations = true
        config.UISimplification.ReduceVisualClutter = true
        config.UISimplification.HideNonEssentialUI = true
        config.SocialSimplification.ReduceNotifications = true
        config.GameplaySimplification.ReducedDecisionPoints = true
    }
    
    if config.Profile.AutismSpectrum {
        config.UISimplification.ConsistentLayout = true
        config.SocialSimplification.HideStrangerInteractions = true
        config.SocialSimplification.PreWrittenResponses = true
        config.SocialSimplification.SocialCueAssistance = true
    }
    
    if config.Profile.CognitiveDecline {
        config.GameplaySimplification.MemoryAssistance = true
        config.GameplaySimplification.StepByStepGuidance = true
        config.GameplaySimplification.HintsEnabled = true
    }
    
    if config.Profile.LearningDisability {
        config.GameplaySimplification.StepByStepGuidance = true
        config.GameplaySimplification.ExtendedTimeLimits = true
        config.GameplaySimplification.TimeMultiplier = 2.0
    }
}
```

### 2. 阅读障碍辅助系统

```go
// backend/shared/cognitive/dyslexia_support.go
package cognitive

import (
    "context"
    "strings"
    "unicode"
)

// DyslexiaSupportConfig 阅读障碍支持配置
type DyslexiaSupportConfig struct {
    FontFamily          string  `json:"font_family"`            // 字体（OpenDyslexic, Lexie Readable）
    FontSize            int     `json:"font_size"`              // 字号（默认 16，建议 18-22）
    LineSpacing         float64 `json:"line_spacing"`           // 行距（建议 1.5-2.0）
    LetterSpacing       float64 `json:"letter_spacing"`         // 字间距
    WordSpacing         float64 `json:"word_spacing"`           // 词间距
    ParagraphSpacing    float64 `json:"paragraph_spacing"`      // 段落间距
    TextAlign           string  `json:"text_align"`             // 对齐方式（left 推荐）
    HighlightCurrentLine bool   `json:"highlight_current_line"` // 高亮当前行
    TextToSpeechEnabled bool    `json:"text_to_speech_enabled"` // 启用文字转语音
    SpeechRate          float64 `json:"speech_rate"`            // 语速
    WordHighlight       bool    `json:"word_highlight"`         // 朗读时高亮单词
    SyllableBreakdown   bool    `json:"syllable_breakdown"`     // 音节分解显示
    ColorOverlay        string  `json:"color_overlay"`          // 颜色覆盖层（减少对比度敏感）
}

// DyslexiaSupportService 阅读障碍支持服务
type DyslexiaSupportService struct {
    ttsService   *TTSService
    fontManager  *FontManager
}

// ProcessTextForDyslexia 处理文本以适应阅读障碍
func (s *DyslexiaSupportService) ProcessTextForDyslexia(ctx context.Context, text string, config DyslexiaSupportConfig) (*ProcessedText, error) {
    result := &ProcessedText{
        OriginalText: text,
    }
    
    // 1. 添加音节分解
    if config.SyllableBreakdown {
        result.SyllableText = s.breakIntoSyllables(text)
    }
    
    // 2. 简化复杂句子
    result.SimplifiedText = s.simplifySentences(text)
    
    // 3. 添加发音提示
    result.PronunciationHints = s.getPronunciationHints(text)
    
    // 4. 标记相似字母组合（bd, pq, mw 等）
    result.SimilarLetterMarks = s.markSimilarLetters(text)
    
    return result, nil
}

// breakIntoSyllables 音节分解
func (s *DyslexiaSupportService) breakIntoSyllables(text string) string {
    words := strings.Fields(text)
    for i, word := range words {
        syllables := s.splitSyllables(word)
        words[i] = strings.Join(syllables, "·")
    }
    return strings.Join(words, " ")
}

// splitSyllables 分割音节（简化版）
func (s *DyslexiaSupportService) splitSyllables(word string) []string {
    // 实际实现需要完整的音节分割算法
    // 这里提供简化版本
    var syllables []string
    current := ""
    
    for i, ch := range word {
        current += string(ch)
        
        // 元音后如果是辅音且后面还有元音，则分割
        if i < len(word)-1 {
            next := rune(word[i+1])
            if isVowel(ch) && !isVowel(next) && i < len(word)-2 {
                if isVowel(rune(word[i+2])) {
                    syllables = append(syllables, current)
                    current = ""
                }
            }
        }
    }
    
    if current != "" {
        syllables = append(syllables, current)
    }
    
    if len(syllables) == 0 {
        return []string{word}
    }
    
    return syllables
}

func isVowel(ch rune) bool {
    return strings.ContainsRune("aeiouAEIOU", unicode.ToLower(ch))
}

// TextToSpeechRequest 文字转语音请求
type TextToSpeechRequest struct {
    Text         string  `json:"text"`
    Language     string  `json:"language"`
    SpeechRate   float64 `json:"speech_rate"`
    Pitch        float64 `json:"pitch"`
    VoiceID      string  `json:"voice_id"`
    HighlightWord bool   `json:"highlight_word"`
}

// TTSService 文字转语音服务
type TTSService struct {
    providers []TTSProvider
}

type TTSProvider interface {
    Synthesize(ctx context.Context, req TextToSpeechRequest) (*AudioData, error)
    GetAvailableVoices(language string) ([]Voice, error)
}

// AudioData 音频数据
type AudioData struct {
    AudioURL     string        `json:"audio_url"`
    Duration     time.Duration `json:"duration"`
    WordTimings  []WordTiming  `json:"word_timings"`
    Format       string        `json:"format"`
}

type WordTiming struct {
    Word      string        `json:"word"`
    StartTime time.Duration `json:"start_time"`
    EndTime   time.Duration `json:"end_time"`
}
```

### 3. ADHD 注意力管理

```go
// backend/shared/cognitive/adhd_support.go
package cognitive

import (
    "context"
    "time"
)

// ADHDSupportConfig ADHD 支持配置
type ADHDSupportConfig struct {
    FocusMode            bool          `json:"focus_mode"`             // 专注模式
    DistractionBlocking  bool          `json:"distraction_blocking"`   // 干扰屏蔽
    PomodoroEnabled      bool          `json:"pomodoro_enabled"`       // 番茄钟
    PomodoroWorkDuration time.Duration `json:"pomodoro_work_duration"` // 工作时长
    PomodoroBreakDuration time.Duration `json:"pomodoro_break_duration"` // 休息时长
    TaskChunking         bool          `json:"task_chunking"`          // 任务分块
    ChunkSize           int           `json:"chunk_size"`             // 分块大小
    RewardFeedback      bool          `json:"reward_feedback"`        // 即时奖励反馈
    ProgressVisualization bool         `json:"progress_visualization"` // 进度可视化
    BreakSuggestions    bool          `json:"break_suggestions"`      // 休息建议
    MovementBreaks      bool          `json:"movement_breaks"`        // 运动休息
}

// FocusSession 专注会话
type FocusSession struct {
    SessionID    string        `json:"session_id"`
    UserID       string        `json:"user_id"`
    StartTime    time.Time     `json:"start_time"`
    EndTime      *time.Time    `json:"end_time,omitempty"`
    TargetTask   string        `json:"target_task"`
    Status       string        `json:"status"` // active, paused, completed, interrupted
    Distractions []Distraction `json:"distractions"`
    Breaks       []Break       `json:"breaks"`
}

type Distraction struct {
    Timestamp time.Time `json:"timestamp"`
    Type      string    `json:"type"` // notification, background_event, etc.
    Blocked   bool      `json:"blocked"`
}

type Break struct {
    StartTime time.Time     `json:"start_time"`
    Duration  time.Duration `json:"duration"`
    Type      string        `json:"type"` // pomodoro, suggested, movement
}

// ADHDSupportService ADHD 支持服务
type ADHDSupportService struct {
    sessionRepo  FocusSessionRepository
    notification *NotificationService
}

// StartFocusSession 开始专注会话
func (s *ADHDSupportService) StartFocusSession(ctx context.Context, userID, task string) (*FocusSession, error) {
    session := &FocusSession{
        SessionID:  generateSessionID(),
        UserID:     userID,
        StartTime:  time.Now(),
        TargetTask: task,
        Status:     "active",
    }
    
    if err := s.sessionRepo.Create(ctx, session); err != nil {
        return nil, err
    }
    
    // 屏蔽干扰
    s.notification.BlockDistractions(ctx, userID, session.SessionID)
    
    return session, nil
}

// ChunkTask 任务分块
func (s *ADHDSupportService) ChunkTask(ctx context.Context, task string, chunkSize int) ([]TaskChunk, error) {
    // 将大任务分解为小步骤
    chunks := []TaskChunk{
        {ID: 1, Description: "准备阶段：了解任务要求", Completed: false, EstimatedTime: 2 * time.Minute},
        {ID: 2, Description: "开始阶段：执行第一个子任务", Completed: false, EstimatedTime: 5 * time.Minute},
        {ID: 3, Description: "进行中：继续执行后续步骤", Completed: false, EstimatedTime: 5 * time.Minute},
        {ID: 4, Description: "收尾阶段：检查和确认", Completed: false, EstimatedTime: 2 * time.Minute},
    }
    
    return chunks, nil
}

// TaskChunk 任务块
type TaskChunk struct {
    ID            int           `json:"id"`
    Description   string        `json:"description"`
    Completed     bool          `json:"completed"`
    EstimatedTime time.Duration `json:"estimated_time"`
    CompletedAt   *time.Time    `json:"completed_at,omitempty"`
}

// ProvideInstantReward 提供即时奖励反馈
func (s *ADHDSupportService) ProvideInstantReward(ctx context.Context, userID string, achievement string) error {
    // ADHD 玩家需要即时反馈
    reward := &InstantReward{
        UserID:      userID,
        Achievement: achievement,
        Type:        "visual_animation", // 或 "sound", "points"
        Message:     "太棒了！你完成了这一步！",
        Points:      10,
        Timestamp:   time.Now(),
    }
    
    return s.notification.SendInstantReward(ctx, reward)
}

type InstantReward struct {
    UserID      string    `json:"user_id"`
    Achievement string    `json:"achievement"`
    Type        string    `json:"type"`
    Message     string    `json:"message"`
    Points      int       `json:"points"`
    Timestamp   time.Time `json:"timestamp"`
}
```

### 4. 自闭症谱系社交辅助

```go
// backend/shared/cognitive/autism_support.go
package cognitive

import (
    "context"
)

// AutismSupportConfig 自闭症谱系支持配置
type AutismSupportConfig struct {
    SocialCueAssistance     bool     `json:"social_cue_assistance"`     // 社交提示辅助
    PreWrittenResponses     bool     `json:"pre_written_responses"`     // 预设回复
    EmotionIndicator        bool     `json:"emotion_indicator"`         // 情绪指示器
    RoutinePreservation     bool     `json:"routine_preservation"`      // 常规保护
    SensorySensitivity      string   `json:"sensory_sensitivity"`       // 感官敏感度（low, medium, high）
    PreferredCommunication   string   `json:"preferred_communication"`   // 首选沟通方式
    SafeSpace               bool     `json:"safe_space"`                // 安全空间模式
    StrangersFilter         bool     `json:"strangers_filter"`          // 陌生人过滤
    DetailedInstructions    bool     `json:"detailed_instructions"`     // 详细指令
    PredictableTransitions  bool     `json:"predictable_transitions"`   // 可预测的转换
    WarningBeforeChanges    bool     `json:"warning_before_changes"`    // 变更前警告
    ChangeNoticeTime        int      `json:"change_notice_time"`        // 变更通知提前时间（分钟）
}

// SocialCue 社交提示
type SocialCue struct {
    Context     string   `json:"context"`      // 场景
    Description string   `json:"description"`  // 提示描述
    Emotions    []string `json:"emotions"`     // 可能的情绪
    Suggestions []string `json:"suggestions"`  // 建议回应
    Intensity   string   `json:"intensity"`    // 社交强度（low, medium, high）
}

// PreWrittenResponse 预设回复
type PreWrittenResponse struct {
    ID          string   `json:"id"`
    Category    string   `json:"category"`    // greeting, goodbye, thanks, apology, etc.
    Text        string   `json:"text"`
    ContextTags []string `json:"context_tags"` // 适用场景标签
    Tone        string   `json:"tone"`        // friendly, formal, casual
}

// AutismSupportService 自闭症谱系支持服务
type AutismSupportService struct {
    socialCueDB      SocialCueRepository
    responseDB       PreWrittenResponseRepository
    routineManager   *RoutineManager
}

// GetSocialCueAssistance 获取社交提示辅助
func (s *AutismSupportService) GetSocialCueAssistance(ctx context.Context, context string) (*SocialCue, error) {
    // 分析当前社交场景
    cue, err := s.socialCueDB.GetByContext(ctx, context)
    if err != nil {
        return nil, err
    }
    
    // 增强提示信息
    cue.Description = s.enhanceDescription(cue.Description)
    cue.Suggestions = s.generateSafeResponses(cue.Suggestions)
    
    return cue, nil
}

// GetPreWrittenResponses 获取预设回复列表
func (s *AutismSupportService) GetPreWrittenResponses(ctx context.Context, category, context string) ([]PreWrittenResponse, error) {
    responses, err := s.responseDB.GetByCategory(ctx, category)
    if err != nil {
        return nil, err
    }
    
    // 根据上下文过滤
    var filtered []PreWrittenResponse
    for _, r := range responses {
        if s.matchesContext(r.ContextTags, context) {
            filtered = append(filtered, r)
        }
    }
    
    return filtered, nil
}

// DetectEmotionalContext 检测情绪上下文
func (s *AutismSupportService) DetectEmotionalContext(ctx context.Context, message string) (*EmotionalContext, error) {
    // 分析消息中的情绪线索
    emotionalCtx := &EmotionalContext{
        DetectedEmotions: []string{},
        Intensity:        "medium",
        SuggestedActions: []string{},
    }
    
    // 检测关键词
    positiveWords := []string{"谢谢", "喜欢", "开心", "高兴", "谢谢", "喜欢"}
    negativeWords := []string{"抱歉", "难过", "生气", "失望", "抱歉", "难过"}
    
    for _, word := range positiveWords {
        if strings.Contains(message, word) {
            emotionalCtx.DetectedEmotions = append(emotionalCtx.DetectedEmotions, "positive")
            emotionalCtx.SuggestedActions = append(emotionalCtx.SuggestedActions, "可以表达感谢或积极回应")
        }
    }
    
    for _, word := range negativeWords {
        if strings.Contains(message, word) {
            emotionalCtx.DetectedEmotions = append(emotionalCtx.DetectedEmotions, "negative")
            emotionalCtx.SuggestedActions = append(emotionalCtx.SuggestedActions, "可以考虑表达理解或提供帮助")
        }
    }
    
    return emotionalCtx, nil
}

type EmotionalContext struct {
    DetectedEmotions []string `json:"detected_emotions"`
    Intensity        string   `json:"intensity"`
    SuggestedActions []string `json:"suggested_actions"`
}

// WarningBeforeChange 变更前警告
func (s *AutismSupportService) WarningBeforeChange(ctx context.Context, userID string, changeType string, changeTime time.Time) error {
    config, err := s.getUserConfig(ctx, userID)
    if err != nil {
        return err
    }
    
    if !config.WarningBeforeChanges {
        return nil
    }
    
    // 计算提前警告时间
    noticeTime := changeTime.Add(-time.Duration(config.ChangeNoticeTime) * time.Minute)
    
    warning := &ChangeWarning{
        UserID:      userID,
        ChangeType:  changeType,
        ScheduledAt: changeTime,
        NoticeAt:    noticeTime,
        Message:     s.generateChangeMessage(changeType),
        CreatedAt:   time.Now(),
    }
    
    // 创建定时警告
    return s.scheduleWarning(ctx, warning)
}

type ChangeWarning struct {
    UserID      string    `json:"user_id"`
    ChangeType  string    `json:"change_type"`
    ScheduledAt time.Time `json:"scheduled_at"`
    NoticeAt    time.Time `json:"notice_at"`
    Message     string    `json:"message"`
    CreatedAt   time.Time `json:"created_at"`
}
```

### 5. 记忆辅助系统

```go
// backend/shared/cognitive/memory_assistance.go
package cognitive

import (
    "context"
    "time"
)

// MemoryAssistanceConfig 记忆辅助配置
type MemoryAssistanceConfig struct {
    TaskReminders      bool `json:"task_reminders"`       // 任务提醒
    LocationMemory     bool `json:"location_memory"`      // 位置记忆
    PokemonMemory      bool `json:"pokemon_memory"`       // 精灵记忆
    QuestProgress      bool `json:"quest_progress"`       // 任务进度
    RecentActions      bool `json:"recent_actions"`       // 最近操作
    ContextualHints    bool `json:"contextual_hints"`     // 上下文提示
    AutoNotes          bool `json:"auto_notes"`           // 自动笔记
    VisualMemoryAids   bool `json:"visual_memory_aids"`   // 视觉记忆辅助
}

// MemoryNote 记忆笔记
type MemoryNote struct {
    ID          string                 `json:"id"`
    UserID      string                 `json:"user_id"`
    Type        string                 `json:"type"` // location, pokemon, quest, event
    Title       string                 `json:"title"`
    Content     string                 `json:"content"`
    Location    *Location              `json:"location,omitempty"`
    PokemonID   *string                `json:"pokemon_id,omitempty"`
    QuestID     *string                `json:"quest_id,omitempty"`
    Tags        []string               `json:"tags"`
    CreatedAt   time.Time              `json:"created_at"`
    AccessedAt  time.Time              `json:"accessed_at"`
    Importance  int                    `json:"importance"` // 1-5
    Metadata    map[string]interface{} `json:"metadata"`
}

type Location struct {
    Name string  `json:"name"`
    Lat  float64 `json:"lat"`
    Lng  float64 `json:"lng"`
}

// MemoryAssistanceService 记忆辅助服务
type MemoryAssistanceService struct {
    noteRepo    MemoryNoteRepository
    aiAssistant *AIAssistant
}

// AutoCreateNote 自动创建记忆笔记
func (s *MemoryAssistanceService) AutoCreateNote(ctx context.Context, event GameEvent) (*MemoryNote, error) {
    // 根据游戏事件自动创建笔记
    note := &MemoryNote{
        ID:         generateNoteID(),
        UserID:     event.UserID,
        Type:       s.determineNoteType(event),
        Title:      s.generateTitle(event),
        Content:    s.generateContent(event),
        Tags:       s.extractTags(event),
        CreatedAt:  time.Now(),
        AccessedAt: time.Now(),
        Importance: s.calculateImportance(event),
        Metadata:   event.Metadata,
    }
    
    // 根据事件类型填充位置/精灵/任务信息
    if event.Location != nil {
        note.Location = event.Location
    }
    if event.PokemonID != "" {
        note.PokemonID = &event.PokemonID
    }
    if event.QuestID != "" {
        note.QuestID = &event.QuestID
    }
    
    if err := s.noteRepo.Create(ctx, note); err != nil {
        return nil, err
    }
    
    return note, nil
}

// GetContextualHints 获取上下文提示
func (s *MemoryAssistanceService) GetContextualHints(ctx context.Context, userID string, currentContext string) ([]ContextualHint, error) {
    // 获取用户最近的相关记忆
    notes, err := s.noteRepo.GetRecentByUser(ctx, userID, 20)
    if err != nil {
        return nil, err
    }
    
    // 根据当前上下文生成提示
    var hints []ContextualHint
    for _, note := range notes {
        if s.isRelevantToContext(note, currentContext) {
            hint := ContextualHint{
                Type:        note.Type,
                Title:       note.Title,
                Description: s.summarizeNote(note),
                Relevance:   s.calculateRelevance(note, currentContext),
                Actions:     s.suggestActions(note),
            }
            hints = append(hints, hint)
        }
    }
    
    // 按相关性排序
    sort.Slice(hints, func(i, j int) bool {
        return hints[i].Relevance > hints[j].Relevance
    })
    
    // 返回最相关的 5 个
    if len(hints) > 5 {
        hints = hints[:5]
    }
    
    return hints, nil
}

type ContextualHint struct {
    Type        string   `json:"type"`
    Title       string   `json:"title"`
    Description string   `json:"description"`
    Relevance   float64  `json:"relevance"`
    Actions     []string `json:"actions"`
}

// GetLocationMemory 获取位置记忆
func (s *MemoryAssistanceService) GetLocationMemory(ctx context.Context, userID string, location *Location) (*LocationMemory, error) {
    // 获取该位置相关的所有记忆
    notes, err := s.noteRepo.GetByLocation(ctx, userID, location)
    if err != nil {
        return nil, err
    }
    
    memory := &LocationMemory{
        Location:       location,
        VisitCount:     len(notes),
        LastVisit:      s.getLastVisit(notes),
        PokemonFound:   s.getPokemonFound(notes),
        QuestsCompleted: s.getQuestsCompleted(notes),
        UserNotes:      s.extractUserNotes(notes),
        Recommendations: s.generateRecommendations(notes),
    }
    
    return memory, nil
}

type LocationMemory struct {
    Location        *Location      `json:"location"`
    VisitCount      int            `json:"visit_count"`
    LastVisit       time.Time      `json:"last_visit"`
    PokemonFound    []string       `json:"pokemon_found"`
    QuestsCompleted []string       `json:"quests_completed"`
    UserNotes       []string       `json:"user_notes"`
    Recommendations []string       `json:"recommendations"`
}

type GameEvent struct {
    UserID     string                 `json:"user_id"`
    Type       string                 `json:"type"`
    Location   *Location              `json:"location,omitempty"`
    PokemonID  string                 `json:"pokemon_id,omitempty"`
    QuestID    string                 `json:"quest_id,omitempty"`
    Metadata   map[string]interface{} `json:"metadata"`
    Timestamp  time.Time              `json:"timestamp"`
}
```

### 6. 前端界面集成

```typescript
// game-client/src/accessibility/CognitiveAccessibilityManager.ts
import { AccessibilityProfile, SimplifiedModeConfig } from './types';

export class CognitiveAccessibilityManager {
  private config: SimplifiedModeConfig;
  private activeFeatures: Map<string, boolean>;

  constructor(private userId: string) {
    this.activeFeatures = new Map();
  }

  async initialize(): Promise<void> {
    // 加载用户配置
    this.config = await this.loadUserConfig();
    
    // 应用配置
    if (this.config.enabled) {
      this.applySimplifiedMode();
    }
    
    // 设置监听器
    this.setupFeatureListeners();
  }

  // 一键启用简化模式
  enableSimplifiedMode(profile: CognitiveProfile): void {
    this.config.enabled = true;
    this.config.profile = profile;
    
    // 根据配置文件类型应用相应设置
    this.applyProfileSettings(profile);
    
    // 保存配置
    this.saveConfig();
    
    // 通知用户
    this.showNotification('简化模式已启用', 'success');
  }

  private applyProfileSettings(profile: CognitiveProfile): void {
    // 阅读障碍设置
    if (profile.dyslexia) {
      this.enableDyslexiaFont();
      this.adjustTextSettings({
        fontSize: 20,
        lineSpacing: 1.8,
        letterSpacing: 0.15,
      });
      this.enableTextToSpeech();
    }
    
    // ADHD 设置
    if (profile.adhd) {
      this.enableFocusMode();
      this.reduceVisualClutter();
      this.enableTaskChunking();
      this.enableInstantRewards();
    }
    
    // 自闭症谱系设置
    if (profile.autismSpectrum) {
      this.enableSocialCueAssistance();
      this.enablePreWrittenResponses();
      this.enableRoutinePreservation();
      this.filterStrangerInteractions();
    }
    
    // 认知衰退设置
    if (profile.cognitiveDecline) {
      this.enableMemoryAssistance();
      this.enableDetailedInstructions();
      this.enableAutoNotes();
    }
    
    // 学习障碍设置
    if (profile.learningDisability) {
      this.extendTimeLimits(2.0);
      this.enableStepByStepGuidance();
      this.simplifyInstructions();
    }
  }

  // 阅读障碍字体
  private enableDyslexiaFont(): void {
    document.documentElement.style.setProperty('--font-family', 'OpenDyslexic, sans-serif');
    document.body.classList.add('dyslexia-font');
  }

  // 文字转语音
  enableTextToSpeech(): void {
    // 初始化 TTS 服务
    this.ttsService = new TextToSpeechService({
      language: this.getCurrentLanguage(),
      rate: this.config.dyslexiaSupport.speechRate,
      highlightWord: this.config.dyslexiaSupport.wordHighlight,
    });
    
    // 为所有文本元素添加 TTS 支持
    document.querySelectorAll('[data-tts]').forEach(element => {
      element.addEventListener('click', () => {
        this.ttsService.speak(element.textContent);
      });
    });
  }

  // 专注模式（ADHD）
  enableFocusMode(): void {
    document.body.classList.add('focus-mode');
    
    // 隐藏非必要 UI
    if (this.config.adhdSupport.distractionBlocking) {
      this.hideNonEssentialElements();
    }
    
    // 启用番茄钟
    if (this.config.adhdSupport.pomodoroEnabled) {
      this.startPomodoroTimer();
    }
  }

  // 社交提示辅助（自闭症谱系）
  enableSocialCueAssistance(): void {
    // 监听社交互动
    this.socialInteractionListener = new SocialInteractionListener({
      onInteraction: (context) => {
        this.showSocialCue(context);
      },
    });
  }

  // 显示社交提示
  private async showSocialCue(context: InteractionContext): Promise<void> {
    const cue = await this.autismSupportService.getSocialCueAssistance(context);
    
    // 显示提示面板
    this.uiManager.showSocialCuePanel({
      description: cue.description,
      emotions: cue.emotions,
      suggestions: cue.suggestions,
    });
  }

  // 记忆辅助
  enableMemoryAssistance(): void {
    // 自动记录重要事件
    this.eventTracker = new EventTracker({
      onImportantEvent: (event) => {
        this.memoryService.autoCreateNote(event);
      },
    });
    
    // 显示上下文提示
    this.contextualHintManager = new ContextualHintManager({
      getCurrentContext: () => this.getCurrentGameContext(),
      showHints: (hints) => this.displayMemoryHints(hints),
    });
  }

  // 延长时间限制
  extendTimeLimits(multiplier: number): void {
    // 修改游戏时间限制
    this.gameTimeManager.setTimeMultiplier(multiplier);
    
    // 延长捕捉时间
    this.catchManager.setExtendedTime(multiplier);
    
    // 延长战斗思考时间
    this.battleManager.setExtendedThinkingTime(multiplier);
  }

  // 步骤引导
  enableStepByStepGuidance(): void {
    this.guidanceManager = new StepByStepGuidanceManager({
      showProgress: true,
      highlightCurrentStep: true,
      autoAdvance: false,
    });
    
    // 在关键操作时显示步骤引导
    this.gameEvents.on('critical-action', (action) => {
      this.guidanceManager.showGuidance(action);
    });
  }

  // 减少视觉干扰
  private reduceVisualClutter(): void {
    document.body.classList.add('reduced-clutter');
    
    // 移除装饰性动画
    this.animationManager.disableDecorativeAnimations();
    
    // 简化背景
    this.backgroundManager.setSimplifiedMode();
  }

  // 即时奖励反馈
  private enableInstantRewards(): void {
    this.rewardManager.enableInstantFeedback({
      onComplete: (achievement) => {
        // 播放动画
        this.playRewardAnimation(achievement);
        
        // 播放音效
        this.playRewardSound();
        
        // 显示鼓励消息
        this.showEncouragement(achievement);
      },
    });
  }
}

// 配置检测向导
export class AccessibilitySetupWizard {
  async startWizard(): Promise<void> {
    const wizard = new Wizard({
      steps: [
        {
          title: '欢迎来到无障碍设置向导',
          content: '这个向导将帮助你找到最适合你的游戏设置。',
        },
        {
          title: '文字阅读',
          question: '你在阅读游戏文字时是否感到困难？',
          options: [
            { label: '经常困难', profile: { dyslexia: true } },
            { label: '有时困难', profile: { dyslexia: true, intensity: 'mild' } },
            { label: '没有困难', profile: {} },
          ],
        },
        {
          title: '注意力管理',
          question: '你是否容易在游戏中分心？',
          options: [
            { label: '经常分心', profile: { adhd: true } },
            { label: '有时分心', profile: { adhd: true, intensity: 'mild' } },
            { label: '没有问题', profile: {} },
          ],
        },
        {
          title: '社交互动',
          question: '你在游戏中与其他玩家互动时是否感到困难？',
          options: [
            { label: '经常困难', profile: { autismSpectrum: true } },
            { label: '有时困难', profile: { autismSpectrum: true, intensity: 'mild' } },
            { label: '没有困难', profile: {} },
          ],
        },
        {
          title: '记忆和提醒',
          question: '你是否需要更多的游戏提醒和记忆辅助？',
          options: [
            { label: '是的，需要帮助', profile: { cognitiveDecline: true } },
            { label: '有时需要', profile: { cognitiveDecline: true, intensity: 'mild' } },
            { label: '不需要', profile: {} },
          ],
        },
      ],
      onComplete: (profile) => {
        this.applyProfile(profile);
        this.saveProfile(profile);
      },
    });
    
    await wizard.start();
  }
}
```

### 7. 数据库设计

```sql
-- 简化模式配置表
CREATE TABLE cognitive_simplified_mode_configs (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id VARCHAR(255) NOT NULL UNIQUE,
    enabled BOOLEAN DEFAULT false,
    profile JSONB NOT NULL DEFAULT '{}',
    ui_simplification JSONB NOT NULL DEFAULT '{}',
    gameplay_simplification JSONB NOT NULL DEFAULT '{}',
    social_simplification JSONB NOT NULL DEFAULT '{}',
    time_limit JSONB,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    
    INDEX idx_user_id (user_id)
);

-- 阅读障碍支持配置表
CREATE TABLE cognitive_dyslexia_support_configs (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id VARCHAR(255) NOT NULL UNIQUE,
    font_family VARCHAR(100) DEFAULT 'OpenDyslexic',
    font_size INT DEFAULT 20,
    line_spacing DECIMAL(3,2) DEFAULT 1.80,
    letter_spacing DECIMAL(3,2) DEFAULT 0.15,
    word_spacing DECIMAL(3,2) DEFAULT 0.20,
    paragraph_spacing DECIMAL(3,2) DEFAULT 2.00,
    text_align VARCHAR(20) DEFAULT 'left',
    highlight_current_line BOOLEAN DEFAULT true,
    text_to_speech_enabled BOOLEAN DEFAULT true,
    speech_rate DECIMAL(3,2) DEFAULT 0.80,
    word_highlight BOOLEAN DEFAULT true,
    syllable_breakdown BOOLEAN DEFAULT false,
    color_overlay VARCHAR(20),
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    
    INDEX idx_user_id (user_id)
);

-- ADHD 支持配置表
CREATE TABLE cognitive_adhd_support_configs (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id VARCHAR(255) NOT NULL UNIQUE,
    focus_mode BOOLEAN DEFAULT false,
    distraction_blocking BOOLEAN DEFAULT true,
    pomodoro_enabled BOOLEAN DEFAULT true,
    pomodoro_work_duration INT DEFAULT 25,
    pomodoro_break_duration INT DEFAULT 5,
    task_chunking BOOLEAN DEFAULT true,
    chunk_size INT DEFAULT 3,
    reward_feedback BOOLEAN DEFAULT true,
    progress_visualization BOOLEAN DEFAULT true,
    break_suggestions BOOLEAN DEFAULT true,
    movement_breaks BOOLEAN DEFAULT false,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    
    INDEX idx_user_id (user_id)
);

-- 自闭症谱系支持配置表
CREATE TABLE cognitive_autism_support_configs (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id VARCHAR(255) NOT NULL UNIQUE,
    social_cue_assistance BOOLEAN DEFAULT true,
    pre_written_responses BOOLEAN DEFAULT true,
    emotion_indicator BOOLEAN DEFAULT true,
    routine_preservation BOOLEAN DEFAULT true,
    sensory_sensitivity VARCHAR(20) DEFAULT 'medium',
    preferred_communication VARCHAR(50),
    safe_space BOOLEAN DEFAULT false,
    strangers_filter BOOLEAN DEFAULT true,
    detailed_instructions BOOLEAN DEFAULT true,
    predictable_transitions BOOLEAN DEFAULT true,
    warning_before_changes BOOLEAN DEFAULT true,
    change_notice_time INT DEFAULT 30,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    
    INDEX idx_user_id (user_id)
);

-- 记忆辅助配置表
CREATE TABLE cognitive_memory_assistance_configs (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id VARCHAR(255) NOT NULL UNIQUE,
    task_reminders BOOLEAN DEFAULT true,
    location_memory BOOLEAN DEFAULT true,
    pokemon_memory BOOLEAN DEFAULT true,
    quest_progress BOOLEAN DEFAULT true,
    recent_actions BOOLEAN DEFAULT true,
    contextual_hints BOOLEAN DEFAULT true,
    auto_notes BOOLEAN DEFAULT true,
    visual_memory_aids BOOLEAN DEFAULT true,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    
    INDEX idx_user_id (user_id)
);

-- 记忆笔记表
CREATE TABLE cognitive_memory_notes (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id VARCHAR(255) NOT NULL,
    type VARCHAR(50) NOT NULL,
    title VARCHAR(255) NOT NULL,
    content TEXT,
    location JSONB,
    pokemon_id VARCHAR(50),
    quest_id VARCHAR(50),
    tags TEXT[] DEFAULT '{}',
    importance INT DEFAULT 3 CHECK (importance BETWEEN 1 AND 5),
    metadata JSONB DEFAULT '{}',
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    accessed_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    
    INDEX idx_user_id (user_id),
    INDEX idx_type (type),
    INDEX idx_created_at (created_at DESC),
    INDEX idx_pokemon_id (pokemon_id),
    INDEX idx_quest_id (quest_id),
    INDEX idx_tags (tags)
);

-- 社交提示库表
CREATE TABLE cognitive_social_cues (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    context VARCHAR(100) NOT NULL,
    description TEXT NOT NULL,
    emotions TEXT[] NOT NULL DEFAULT '{}',
    suggestions TEXT[] NOT NULL DEFAULT '{}',
    intensity VARCHAR(20) DEFAULT 'medium',
    language VARCHAR(10) DEFAULT 'zh',
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    
    INDEX idx_context (context),
    INDEX idx_language (language)
);

-- 预设回复表
CREATE TABLE cognitive_pre_written_responses (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    category VARCHAR(50) NOT NULL,
    text TEXT NOT NULL,
    context_tags TEXT[] DEFAULT '{}',
    tone VARCHAR(20) DEFAULT 'friendly',
    language VARCHAR(10) DEFAULT 'zh',
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    
    INDEX idx_category (category),
    INDEX idx_language (language),
    INDEX idx_context_tags (context_tags)
);

-- 专注会话表
CREATE TABLE cognitive_focus_sessions (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id VARCHAR(255) NOT NULL,
    start_time TIMESTAMP WITH TIME ZONE NOT NULL,
    end_time TIMESTAMP WITH TIME ZONE,
    target_task VARCHAR(255),
    status VARCHAR(20) DEFAULT 'active',
    distractions JSONB DEFAULT '[]',
    breaks JSONB DEFAULT '[]',
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    
    INDEX idx_user_id (user_id),
    INDEX idx_status (status),
    INDEX idx_start_time (start_time DESC)
);

-- 变更警告表
CREATE TABLE cognitive_change_warnings (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id VARCHAR(255) NOT NULL,
    change_type VARCHAR(100) NOT NULL,
    scheduled_at TIMESTAMP WITH TIME ZONE NOT NULL,
    notice_at TIMESTAMP WITH TIME ZONE NOT NULL,
    message TEXT NOT NULL,
    delivered BOOLEAN DEFAULT false,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    
    INDEX idx_user_id (user_id),
    INDEX idx_notice_at (notice_at),
    INDEX idx_delivered (delivered)
);
```

### 8. API 端点设计

```go
// 简化模式 API
GET    /api/v1/cognitive/simplified-mode            // 获取简化模式配置
POST   /api/v1/cognitive/simplified-mode/enable     // 启用简化模式
PUT    /api/v1/cognitive/simplified-mode            // 更新简化模式配置
DELETE /api/v1/cognitive/simplified-mode            // 禁用简化模式

// 阅读障碍支持 API
GET    /api/v1/cognitive/dyslexia/config            // 获取阅读障碍配置
PUT    /api/v1/cognitive/dyslexia/config            // 更新阅读障碍配置
POST   /api/v1/cognitive/dyslexia/tts               // 文字转语音
POST   /api/v1/cognitive/dyslexia/syllables         // 获取音节分解

// ADHD 支持 API
GET    /api/v1/cognitive/adhd/config                // 获取 ADHD 配置
PUT    /api/v1/cognitive/adhd/config                // 更新 ADHD 配置
POST   /api/v1/cognitive/adhd/focus-session/start   // 开始专注会话
POST   /api/v1/cognitive/adhd/focus-session/end     // 结束专注会话
GET    /api/v1/cognitive/adhd/task-chunks           // 获取任务分块
POST   /api/v1/cognitive/adhd/instant-reward        // 发送即时奖励

// 自闭症谱系支持 API
GET    /api/v1/cognitive/autism/config              // 获取自闭症配置
PUT    /api/v1/cognitive/autism/config              // 更新自闭症配置
GET    /api/v1/cognitive/autism/social-cue          // 获取社交提示
GET    /api/v1/cognitive/autism/prewritten-responses // 获取预设回复
POST   /api/v1/cognitive/autism/warning             // 创建变更警告

// 记忆辅助 API
GET    /api/v1/cognitive/memory/config              // 获取记忆辅助配置
PUT    /api/v1/cognitive/memory/config              // 更新记忆辅助配置
POST   /api/v1/cognitive/memory/note                // 创建记忆笔记
GET    /api/v1/cognitive/memory/notes               // 获取记忆笔记列表
GET    /api/v1/cognitive/memory/contextual-hints    // 获取上下文提示
GET    /api/v1/cognitive/memory/location            // 获取位置记忆

// 设置向导 API
POST   /api/v1/cognitive/setup-wizard/start         // 开始设置向导
POST   /api/v1/cognitive/setup-wizard/step          // 提交向导步骤
POST   /api/v1/cognitive/setup-wizard/complete      // 完成向导
```

## 验收标准

- [ ] **简化模式**
  - [ ] 一键启用简化模式功能正常
  - [ ] 根据认知障碍类型自动应用对应设置
  - [ ] UI 简化选项正确生效
  - [ ] 游戏玩法简化选项正确生效

- [ ] **阅读障碍支持**
  - [ ] OpenDyslexic 字体正确加载
  - [ ] 字号、行距、字间距设置生效
  - [ ] 文字转语音功能正常
  - [ ] 音节分解显示正确
  - [ ] 朗读时单词高亮功能正常

- [ ] **ADHD 支持**
  - [ ] 专注模式正确屏蔽干扰
  - [ ] 番茄钟计时器功能正常
  - [ ] 任务分块显示清晰
  - [ ] 即时奖励反馈触发及时
  - [ ] 进度可视化直观明了

- [ ] **自闭症谱系支持**
  - [ ] 社交提示辅助正确显示
  - [ ] 预设回复列表完整
  - [ ] 情绪指示器功能正常
  - [ ] 变更前警告提前发送
  - [ ] 陌生人互动过滤生效

- [ ] **记忆辅助**
  - [ ] 自动笔记功能正常
  - [ ] 上下文提示相关性高
  - [ ] 位置记忆记录准确
  - [ ] 任务提醒准时触发

- [ ] **设置向导**
  - [ ] 向导流程顺畅
  - [ ] 问题选项清晰
  - [ ] 根据回答正确推荐设置

- [ ] **无障碍合规**
  - [ ] WCAG 2.1 AAA 级认知功能标准合规
  - [ ] Game Accessibility Guidelines 基础级合规
  - [ ] 所有功能可通过键盘访问
  - [ ] 屏幕阅读器兼容

- [ ] **测试覆盖**
  - [ ] 单元测试覆盖率 ≥ 80%
  - [ ] 集成测试通过
  - [ ] 与真实用户群体进行可用性测试

- [ ] **文档完整**
  - [ ] 用户手册清晰
  - [ ] 开发者文档完整
  - [ ] 无障碍声明公开

## 影响范围

### 新增文件
- `backend/shared/cognitive/simplified_mode.go`
- `backend/shared/cognitive/dyslexia_support.go`
- `backend/shared/cognitive/adhd_support.go`
- `backend/shared/cognitive/autism_support.go`
- `backend/shared/cognitive/memory_assistance.go`
- `backend/shared/cognitive/models.go`
- `backend/shared/cognitive/repository.go`
- `game-client/src/accessibility/CognitiveAccessibilityManager.ts`
- `game-client/src/accessibility/AccessibilitySetupWizard.ts`
- `game-client/src/accessibility/components/SocialCuePanel.tsx`
- `game-client/src/accessibility/components/MemoryHintDisplay.tsx`
- `game-client/src/accessibility/components/FocusModeIndicator.tsx`
- `docs/accessibility/cognitive-accessibility-guide.md`

### 修改文件
- `game-client/src/App.tsx` - 集成认知无障碍管理器
- `game-client/src/styles/accessibility.css` - 添加认知无障碍样式
- `backend/user-service/handlers/user_preferences.go` - 添加无障碍偏好
- `backend/gateway/routes.go` - 添加认知无障碍 API 路由
- `database/migrations/` - 添加数据库迁移脚本

### 数据库变更
- 新增 10 张表（配置表、笔记表、会话表等）

## 参考

- [WCAG 2.1 Cognitive Accessibility Guidelines](https://www.w3.org/WAI/WCAG21/Understanding/cognitive-accessibility)
- [Game Accessibility Guidelines - Cognitive](http://gameaccessibilityguidelines.com/basic/cognitive/)
- [OpenDyslexic Font](https://opendyslexic.org/)
- [Xbox Adaptive Controller](https://www.xbox.com/en-US/accessories/controllers/xbox-adaptive-controller)
- [Apple Accessibility Features](https://www.apple.com/accessibility/)
- [Microsoft Accessibility](https://www.microsoft.com/design/inclusive/)
- [The Cognitive Accessibility Task Force (Cognitive A11Y TF)](https://www.w3.org/WAI/PF/cognitive-a11y-tf/)
- [Dyslexia Style Guide](https://www.bdadyslexia.org.uk/advice/employers/creating-a-dyslexia-friendly-workplace/dyslexia-friendly-style-guide)
