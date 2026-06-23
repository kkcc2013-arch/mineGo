# REQ-00293: 分布式追踪与 OpenTelemetry 集成系统

## 元信息
| 字段 | 值 |
|------|-----|
| 编号 | REQ-00293 |
| 标题 | 分布式追踪与 OpenTelemetry 集成系统 |
| 类别 | 可观测性 |
| 优先级 | P1 |
| 状态 | new |
| 涉及服务 | gateway, 所有微服务, backend/shared/tracing, jaeger, backend/shared/middleware |
| 创建时间 | 2026-06-23 09:00 |

## 需求描述

为 mineGo 微服务架构实现完整的分布式追踪系统，基于 OpenTelemetry 标准，实现请求链路的端到端可视化追踪。系统需要支持自动埋点、上下文传播、采样策略、性能分析与根因定位，帮助开发团队快速定位分布式系统中的性能瓶颈和故障节点。

### 核心目标

1. **全链路追踪**：从 API Gateway 到下游服务的完整调用链追踪
2. **自动埋点**：减少手动埋点代码，自动捕获关键操作
3. **上下文传播**：跨进程、跨协议的 Trace Context 传播
4. **智能采样**：基于流量和异常的动态采样策略
5. **性能分析**：识别慢查询、热点路径和性能瓶颈
6. **故障定位**：快速定位错误根因和异常节点

## 技术方案

### 1. OpenTelemetry SDK 集成

```go
// backend/shared/tracing/tracer.go
package tracing

import (
	"context"
	"fmt"
	"os"

	"go.opentelemetry.io/otel"
	"go.opentelemetry.io/otel/attribute"
	"go.opentelemetry.io/otel/exporters/jaeger"
	"go.opentelemetry.io/otel/propagation"
	"go.opentelemetry.io/otel/sdk/resource"
	sdktrace "go.opentelemetry.io/otel/sdk/trace"
	semconv "go.opentelemetry.io/otel/semconv/v1.21.0"
	"go.opentelemetry.io/otel/trace"
)

type TracingConfig struct {
	ServiceName    string
	Environment    string
	JaegerEndpoint string
	SampleRate     float64
}

func InitializeTracer(cfg *TracingConfig) (func(context.Context) error, error) {
	// 创建 Jaeger exporter
	exporter, err := jaeger.New(jaeger.WithCollectorEndpoint(
		jaeger.WithEndpoint(cfg.JaegerEndpoint),
	))
	if err != nil {
		return nil, fmt.Errorf("failed to create Jaeger exporter: %w", err)
	}

	// 创建资源（服务信息）
	res, err := resource.Merge(
		resource.Default(),
		resource.NewWithAttributes(
			semconv.SchemaURL,
			semconv.ServiceName(cfg.ServiceName),
			semconv.ServiceVersion(os.Getenv("SERVICE_VERSION")),
			semconv.DeploymentEnvironment(cfg.Environment),
		),
	)
	if err != nil {
		return nil, fmt.Errorf("failed to create resource: %w", err)
	}

	// 创建采样器
	sampler := NewAdaptiveSampler(cfg.SampleRate)

	// 创建 TracerProvider
	tp := sdktrace.NewTracerProvider(
		sdktrace.WithBatcher(exporter),
		sdktrace.WithResource(res),
		sdktrace.WithSampler(sampler),
	)

	// 设置全局 TracerProvider
	otel.SetTracerProvider(tp)

	// 设置全局传播器（W3C Trace Context）
	otel.SetTextMapPropagator(propagation.NewCompositeTextMapPropagator(
		propagation.TraceContext{},
		propagation.Baggage{},
	))

	return tp.Shutdown, nil
}

// GetTracer 获取命名 Tracer
func GetTracer(name string) trace.Tracer {
	return otel.Tracer(name)
}
```

### 2. 自适应采样器

```go
// backend/shared/tracing/sampler.go
package tracing

import (
	"context"
	"math"
	"sync"
	"sync/atomic"
	"time"

	sdktrace "go.opentelemetry.io/otel/sdk/trace"
	"go.opentelemetry.io/otel/trace"
)

type AdaptiveSampler struct {
	baseRate         float64
	errorRate        float64
	slowTraceRate    float64
	totalSpans       int64
	errorSpans       int64
	slowSpans        int64
	mu               sync.RWMutex
	slowThresholdMs  int64
	statsWindow      *SlidingWindow
}

type SlidingWindow struct {
	mu       sync.RWMutex
	windows  []WindowStats
	size     int
	interval time.Duration
}

type WindowStats struct {
	Timestamp   time.Time
	TotalSpans  int64
	ErrorSpans  int64
	SlowSpans   int64
}

func NewAdaptiveSampler(baseRate float64) *AdaptiveSampler {
	return &AdaptiveSampler{
		baseRate:        baseRate,
		errorRate:       1.0, // 错误请求 100% 采样
		slowTraceRate:   1.0, // 慢请求 100% 采样
		slowThresholdMs: 1000,
		statsWindow: &SlidingWindow{
			windows:  make([]WindowStats, 0, 60),
			size:     60,
			interval: time.Minute,
		},
	}
}

func (s *AdaptiveSampler) ShouldSample(p sdktrace.SamplingParameters) sdktrace.SamplingResult {
	ctx := context.Background()
	
	// 统计总数
	atomic.AddInt64(&s.totalSpans, 1)

	// 判断是否为错误请求
	if s.isErrorSpan(p) {
		atomic.AddInt64(&s.errorSpans, 1)
		return s.makeDecision(sdktrace.RecordAndSample)
	}

	// 判断是否为慢请求
	if s.isSlowSpan(p) {
		atomic.AddInt64(&s.slowSpans, 1)
		return s.makeDecision(sdktrace.RecordAndSample)
	}

	// 高优先级操作（支付、交易等）
	if s.isHighPriorityOperation(p) {
		return s.makeDecision(sdktrace.RecordAndSample)
	}

	// 基础采样率
	return s.makeDecision(sdktrace.TraceIDRatioBased(s.baseRate).ShouldSample(p).Decision)
}

func (s *AdaptiveSampler) isErrorSpan(p sdktrace.SamplingParameters) bool {
	for _, attr := range p.Attributes {
		if attr.Key == "error" && attr.Value.AsBool() {
			return true
		}
	}
	return false
}

func (s *AdaptiveSampler) isSlowSpan(p sdktrace.SamplingParameters) bool {
	for _, attr := range p.Attributes {
		if attr.Key == "duration_ms" {
			if attr.Value.AsInt64() > s.slowThresholdMs {
				return true
			}
		}
	}
	return false
}

func (s *AdaptiveSampler) isHighPriorityOperation(p sdktrace.SamplingParameters) bool {
	highPriorityOps := []string{
		"payment.process",
		"trade.execute",
		"exchange.create",
		"user.delete",
		"admin.action",
	}
	
	for _, attr := range p.Attributes {
		if attr.Key == "operation.type" {
			for _, op := range highPriorityOps {
				if attr.Value.AsString() == op {
					return true
				}
			}
		}
	}
	return false
}

func (s *AdaptiveSampler) makeDecision(decision sdktrace.SamplingDecision) sdktrace.SamplingResult {
	return sdktrace.SamplingResult{
		Decision:   decision,
		Attributes: []attribute.KeyValue{},
	}
}

func (s *AdaptiveSampler) Description() string {
	return "AdaptiveSampler"
}

// 动态调整采样率
func (s *AdaptiveSampler) AdjustSampleRate() {
	s.mu.Lock()
	defer s.mu.Unlock()

	// 根据错误率动态调整
	total := atomic.LoadInt64(&s.totalSpans)
	errors := atomic.LoadInt64(&s.errorSpans)
	
	if total > 0 {
		errorRate := float64(errors) / float64(total)
		// 错误率高时，增加采样率
		if errorRate > 0.05 {
			s.baseRate = math.Min(s.baseRate*1.2, 1.0)
		} else if errorRate < 0.01 {
			s.baseRate = math.Max(s.baseRate*0.8, 0.01)
		}
	}
}
```

### 3. 自动埋点中间件

```go
// backend/shared/middleware/tracing_middleware.go
package middleware

import (
	"context"
	"time"

	"github.com/gin-gonic/gin"
	"go.opentelemetry.io/otel"
	"go.opentelemetry.io/otel/attribute"
	"go.opentelemetry.io/otel/codes"
	"go.opentelemetry.io/otel/propagation"
	"go.opentelemetry.io/otel/trace"
)

func TracingMiddleware(serviceName string) gin.HandlerFunc {
	tracer := otel.Tracer(serviceName)
	propagator := otel.GetTextMapPropagator()

	return func(c *gin.Context) {
		start := time.Now()

		// 从请求中提取 Trace Context
		ctx := propagator.Extract(c.Request.Context(), propagation.HeaderCarrier(c.Request.Header))

		// 创建 Span
		spanName := c.Request.Method + " " + c.FullPath()
		if spanName == " " {
			spanName = c.Request.Method + " " + c.Request.URL.Path
		}

		ctx, span := tracer.Start(ctx, spanName,
			trace.WithSpanKind(trace.SpanKindServer),
			trace.WithAttributes(
				attribute.String("http.method", c.Request.Method),
				attribute.String("http.url", c.Request.URL.String()),
				attribute.String("http.route", c.FullPath()),
				attribute.String("http.host", c.Request.Host),
				attribute.String("http.scheme", c.Request.URL.Scheme),
				attribute.String("http.user_agent", c.Request.UserAgent()),
				attribute.Int64("http.request_content_length", c.Request.ContentLength),
			),
		)
		defer span.End()

		// 将 context 注入到 gin.Context
		c.Request = c.Request.WithContext(ctx)

		// 执行请求
		c.Next()

		// 记录响应信息
		duration := time.Since(start)
		statusCode := c.Writer.Status()

		span.SetAttributes(
			attribute.Int("http.status_code", statusCode),
			attribute.Int64("http.response_content_length", c.Writer.Size()),
			attribute.Float64("http.duration_ms", float64(duration.Milliseconds())),
		)

		// 设置 Span 状态
		if statusCode >= 400 {
			span.SetStatus(codes.Error, c.Errors.String())
			span.SetAttributes(attribute.Bool("error", true))
		} else {
			span.SetStatus(codes.Ok, "")
		}

		// 将 Trace ID 注入响应头
		traceID := span.SpanContext().TraceID().String()
		c.Header("X-Trace-Id", traceID)
	}
}

// RPC 客户端拦截器
func UnaryClientInterceptor(tracerName string) grpc.UnaryClientInterceptor {
	tracer := otel.Tracer(tracerName)
	propagator := otel.GetTextMapPropagator()

	return func(ctx context.Context, method string, req, reply interface{}, cc *grpc.ClientConn, invoker grpc.UnaryInvoker, opts ...grpc.CallOption) error {
		// 创建客户端 Span
		ctx, span := tracer.Start(ctx, method,
			trace.WithSpanKind(trace.SpanKindClient),
			trace.WithAttributes(
				attribute.String("rpc.system", "grpc"),
				attribute.String("rpc.method", method),
			),
		)
		defer span.End()

		// 注入 Trace Context 到 gRPC Metadata
		md, ok := metadata.FromOutgoingContext(ctx)
		if !ok {
			md = metadata.New(nil)
		}
		propagator.Inject(ctx, propagation.HeaderCarrier(md))
		ctx = metadata.NewOutgoingContext(ctx, md)

		// 执行 RPC 调用
		err := invoker(ctx, method, req, reply, cc, opts...)

		// 设置错误状态
		if err != nil {
			span.RecordError(err)
			span.SetStatus(codes.Error, err.Error())
		}

		return err
	}
}

// RPC 服务端拦截器
func UnaryServerInterceptor(tracerName string) grpc.UnaryServerInterceptor {
	tracer := otel.Tracer(tracerName)
	propagator := otel.GetTextMapPropagator()

	return func(ctx context.Context, req interface{}, info *grpc.UnaryServerInfo, handler grpc.UnaryHandler) (interface{}, error) {
		// 从 gRPC Metadata 中提取 Trace Context
		md, ok := metadata.FromIncomingContext(ctx)
		if ok {
			ctx = propagator.Extract(ctx, propagation.HeaderCarrier(md))
		}

		// 创建服务端 Span
		ctx, span := tracer.Start(ctx, info.FullMethod,
			trace.WithSpanKind(trace.SpanKindServer),
			trace.WithAttributes(
				attribute.String("rpc.system", "grpc"),
				attribute.String("rpc.method", info.FullMethod),
			),
		)
		defer span.End()

		// 执行 handler
		resp, err := handler(ctx, req)

		// 设置错误状态
		if err != nil {
			span.RecordError(err)
			span.SetStatus(codes.Error, err.Error())
		}

		return resp, err
	}
}
```

### 4. 数据库追踪集成

```go
// backend/shared/tracing/db_tracing.go
package tracing

import (
	"context"
	"database/sql/driver"
	"time"

	"go.opentelemetry.io/otel"
	"go.opentelemetry.io/otel/attribute"
	"go.opentelemetry.io/otel/codes"
	"go.opentelemetry.io/otel/trace"
)

type TracingDriver struct {
	driver.Driver
	tracerName string
}

func WrapDriver(d driver.Driver, tracerName string) *TracingDriver {
	return &TracingDriver{
		Driver:     d,
		tracerName: tracerName,
	}
}

func (d *TracingDriver) Open(name string) (driver.Conn, error) {
	conn, err := d.Driver.Open(name)
	if err != nil {
		return nil, err
	}
	return &TracingConn{Conn: conn, tracerName: d.tracerName}, nil
}

type TracingConn struct {
	driver.Conn
	tracerName string
}

func (c *TracingConn) QueryContext(ctx context.Context, query string, args []driver.NamedValue) (driver.Rows, error) {
	start := time.Now()
	tracer := otel.Tracer(c.tracerName)

	ctx, span := tracer.Start(ctx, "db.query",
		trace.WithSpanKind(trace.SpanKindClient),
		trace.WithAttributes(
			attribute.String("db.system", "postgresql"),
			attribute.String("db.statement", query),
			attribute.Int("db.args.count", len(args)),
		),
	)
	defer span.End()

	rows, err := c.Conn.(driver.QueryerContext).QueryContext(ctx, query, args)
	
	duration := time.Since(start)
	span.SetAttributes(
		attribute.Float64("db.duration_ms", float64(duration.Milliseconds())),
	)

	if err != nil {
		span.RecordError(err)
		span.SetStatus(codes.Error, err.Error())
		return nil, err
	}

	// 标记慢查询
	if duration.Milliseconds() > 500 {
		span.SetAttributes(attribute.Bool("db.slow_query", true))
	}

	span.SetStatus(codes.Ok, "")
	return rows, nil
}

func (c *TracingConn) ExecContext(ctx context.Context, query string, args []driver.NamedValue) (driver.Result, error) {
	start := time.Now()
	tracer := otel.Tracer(c.tracerName)

	ctx, span := tracer.Start(ctx, "db.exec",
		trace.WithSpanKind(trace.SpanKindClient),
		trace.WithAttributes(
			attribute.String("db.system", "postgresql"),
			attribute.String("db.statement", query),
			attribute.Int("db.args.count", len(args)),
		),
	)
	defer span.End()

	result, err := c.Conn.(driver.ExecerContext).ExecContext(ctx, query, args)
	
	duration := time.Since(start)
	span.SetAttributes(
		attribute.Float64("db.duration_ms", float64(duration.Milliseconds())),
	)

	if err != nil {
		span.RecordError(err)
		span.SetStatus(codes.Error, err.Error())
		return nil, err
	}

	// 记录影响行数
	if rowsAffected, _ := result.RowsAffected(); rowsAffected >= 0 {
		span.SetAttributes(attribute.Int64("db.rows_affected", rowsAffected))
	}

	span.SetStatus(codes.Ok, "")
	return result, nil
}
```

### 5. Redis 追踪集成

```go
// backend/shared/tracing/redis_tracing.go
package tracing

import (
	"context"
	"time"

	"github.com/go-redis/redis/v8"
	"go.opentelemetry.io/otel"
	"go.opentelemetry.io/otel/attribute"
	"go.opentelemetry.io/otel/codes"
	"go.opentelemetry.io/otel/trace"
)

type TracingHook struct {
	tracer trace.Tracer
}

func NewRedisHook() *TracingHook {
	return &TracingHook{
		tracer: otel.Tracer("redis-client"),
	}
}

func (h *TracingHook) BeforeProcess(ctx context.Context, cmd redis.Cmder) (context.Context, error) {
	ctx, span := h.tracer.Start(ctx, "redis."+cmd.Name(),
		trace.WithSpanKind(trace.SpanKindClient),
		trace.WithAttributes(
			attribute.String("db.system", "redis"),
			attribute.String("db.operation", cmd.Name()),
			attribute.String("db.statement", cmd.String()),
		),
	)
	return ctx, nil
}

func (h *TracingHook) AfterProcess(ctx context.Context, cmd redis.Cmder) error {
	span := trace.SpanFromContext(ctx)
	defer span.End()

	if err := cmd.Err(); err != nil && err != redis.Nil {
		span.RecordError(err)
		span.SetStatus(codes.Error, err.Error())
	} else {
		span.SetStatus(codes.Ok, "")
	}

	return nil
}

func (h *TracingHook) BeforeProcessPipeline(ctx context.Context, cmds []redis.Cmder) (context.Context, error) {
	ctx, span := h.tracer.Start(ctx, "redis.pipeline",
		trace.WithSpanKind(trace.SpanKindClient),
		trace.WithAttributes(
			attribute.String("db.system", "redis"),
			attribute.Int("db.pipeline.length", len(cmds)),
		),
	)
	return ctx, nil
}

func (h *TracingHook) AfterProcessPipeline(ctx context.Context, cmds []redis.Cmder) error {
	span := trace.SpanFromContext(ctx)
	defer span.End()

	for _, cmd := range cmds {
		if err := cmd.Err(); err != nil && err != redis.Nil {
			span.RecordError(err)
			span.SetStatus(codes.Error, err.Error())
			return nil
		}
	}

	span.SetStatus(codes.Ok, "")
	return nil
}
```

### 6. 服务间追踪上下文传播

```go
// backend/shared/tracing/context_propagation.go
package tracing

import (
	"context"
	"encoding/json"

	"github.com/streadway/amqp"
	"go.opentelemetry.io/otel"
	"go.opentelemetry.io/otel/attribute"
	"go.opentelemetry.io/otel/propagation"
	"go.opentelemetry.io/otel/trace"
)

// RabbitMQ 消息追踪
func InjectTraceContextToAMQP(ctx context.Context, msg *amqp.Publishing) {
	propagator := otel.GetTextMapPropagator()
	
	// 创建一个 map 来存储 trace context
	carrier := make(map[string]string)
	propagator.Inject(ctx, propagation.MapCarrier(carrier))
	
	// 序列化为 JSON 并放入 headers
	if data, err := json.Marshal(carrier); err == nil {
		if msg.Headers == nil {
			msg.Headers = make(amqp.Table)
		}
		msg.Headers["trace-context"] = string(data)
	}
}

func ExtractTraceContextFromAMQP(ctx context.Context, msg amqp.Delivery) context.Context {
	propagator := otel.GetTextMapPropagator()
	
	if data, ok := msg.Headers["trace-context"].(string); ok {
		var carrier map[string]string
		if err := json.Unmarshal([]byte(data), &carrier); err == nil {
			ctx = propagator.Extract(ctx, propagation.MapCarrier(carrier))
		}
	}
	
	return ctx
}

// Kafka 消息追踪
func InjectTraceContextToKafka(ctx context.Context, headers *[]map[string]string) {
	propagator := otel.GetTextMapPropagator()
	carrier := make(map[string]string)
	propagator.Inject(ctx, propagation.MapCarrier(carrier))
	*headers = append(*headers, carrier)
}

func ExtractTraceContextFromKafka(ctx context.Context, headers []map[string]string) context.Context {
	propagator := otel.GetTextMapPropagator()
	for _, h := range headers {
		ctx = propagator.Extract(ctx, propagation.MapCarrier(h))
	}
	return ctx
}

// 创建子 Span 的工具函数
func CreateChildSpan(ctx context.Context, tracerName, spanName string, attrs ...attribute.KeyValue) (context.Context, trace.Span) {
	tracer := otel.Tracer(tracerName)
	return tracer.Start(ctx, spanName,
		trace.WithAttributes(attrs...),
	)
}

// 标记 Span 为错误
func MarkSpanError(ctx context.Context, err error) {
	span := trace.SpanFromContext(ctx)
	span.RecordError(err)
	span.SetStatus(codes.Error, err.Error())
}

// 添加 Span 属性
func AddSpanAttributes(ctx context.Context, attrs ...attribute.KeyValue) {
	span := trace.SpanFromContext(ctx)
	span.SetAttributes(attrs...)
}
```

### 7. Trace 分析与查询服务

```go
// backend/services/trace-analysis-service/main.go
package main

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"time"

	"github.com/gin-gonic/gin"
)

type TraceAnalysisService struct {
	jaegerClient *JaegerClient
}

type TraceSummary struct {
	TraceID        string          `json:"trace_id"`
	RootService    string          `json:"root_service"`
	RootOperation  string          `json:"root_operation"`
	Duration       time.Duration   `json:"duration"`
	SpanCount      int             `json:"span_count"`
	ErrorCount     int             `json:"error_count"`
	Services       []string        `json:"services"`
	SlowestSpans   []SpanInfo      `json:"slowest_spans"`
	CriticalPath   []SpanInfo      `json:"critical_path"`
}

type SpanInfo struct {
	SpanID      string        `json:"span_id"`
	Service     string        `json:"service"`
	Operation   string        `json:"operation"`
	Duration    time.Duration `json:"duration"`
	HasError    bool          `json:"has_error"`
	Depth       int           `json:"depth"`
}

// 获取 Trace 详情
func (s *TraceAnalysisService) GetTrace(c *gin.Context) {
	traceID := c.Param("traceId")
	
	trace, err := s.jaegerClient.GetTrace(c.Request.Context(), traceID)
	if err != nil {
		c.JSON(http.StatusNotFound, gin.H{"error": "trace not found"})
		return
	}

	summary := s.analyzeTrace(trace)
	c.JSON(http.StatusOK, summary)
}

// 分析 Trace
func (s *TraceAnalysisService) analyzeTrace(trace *Trace) *TraceSummary {
	summary := &TraceSummary{
		TraceID:      trace.TraceID,
		SpanCount:    len(trace.Spans),
		Services:     make([]string, 0),
		SlowestSpans: make([]SpanInfo, 0),
		CriticalPath: make([]SpanInfo, 0),
	}

	serviceSet := make(map[string]bool)
	slowestMap := make(map[string]SpanInfo)

	for _, span := range trace.Spans {
		// 收集服务
		serviceSet[span.Service] = true

		// 统计错误
		if span.HasError {
			summary.ErrorCount++
		}

		// 记录最慢 Span
		if current, exists := slowestMap[span.Operation]; !exists || span.Duration > current.Duration {
			slowestMap[span.Operation] = SpanInfo{
				SpanID:    span.SpanID,
				Service:   span.Service,
				Operation: span.Operation,
				Duration:  span.Duration,
				HasError:  span.HasError,
				Depth:     span.Depth,
			}
		}

		// 识别根 Span
		if span.ParentID == "" {
			summary.RootService = span.Service
			summary.RootOperation = span.Operation
			summary.Duration = span.Duration
		}
	}

	// 转换服务列表
	for service := range serviceSet {
		summary.Services = append(summary.Services, service)
	}

	// 提取最慢 Span（Top 10）
	for _, span := range slowestMap {
		summary.SlowestSpans = append(summary.SlowestSpans, span)
		if len(summary.SlowestSpans) >= 10 {
			break
		}
	}

	// 计算关键路径
	summary.CriticalPath = s.calculateCriticalPath(trace)

	return summary
}

// 计算关键路径
func (s *TraceAnalysisService) calculateCriticalPath(trace *Trace) []SpanInfo {
	// 构建调用树
	spanMap := make(map[string]*Span)
	var rootSpan *Span

	for i := range trace.Spans {
		spanMap[trace.Spans[i].SpanID] = &trace.Spans[i]
		if trace.Spans[i].ParentID == "" {
			rootSpan = &trace.Spans[i]
		}
	}

	// 计算每个节点的关键路径权重
	criticalPath := make([]SpanInfo, 0)
	s.findCriticalPath(rootSpan, spanMap, &criticalPath)

	return criticalPath
}

func (s *TraceAnalysisService) findCriticalPath(span *Span, spanMap map[string]*Span, path *[]SpanInfo) {
	if span == nil {
		return
	}

	*path = append(*path, SpanInfo{
		SpanID:    span.SpanID,
		Service:   span.Service,
		Operation: span.Operation,
		Duration:  span.Duration,
		HasError:  span.HasError,
	})

	// 找到子节点中最慢的那个
	var slowestChild *Span
	for _, child := range spanMap {
		if child.ParentID == span.SpanID {
			if slowestChild == nil || child.Duration > slowestChild.Duration {
				slowestChild = child
			}
		}
	}

	// 递归处理最慢子节点
	s.findCriticalPath(slowestChild, spanMap, path)
}

// 查询慢 Trace
func (s *TraceAnalysisService) GetSlowTraces(c *gin.Context) {
	service := c.Query("service")
	threshold, _ := time.ParseDuration(c.DefaultQuery("threshold", "2s"))
	limit := 50

	traces, err := s.jaegerClient.QueryTraces(c.Request.Context(), map[string]interface{}{
		"service":     service,
		"minDuration": threshold.String(),
		"limit":       limit,
	})

	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}

	c.JSON(http.StatusOK, traces)
}

// 查询错误 Trace
func (s *TraceAnalysisService) GetErrorTraces(c *gin.Context) {
	service := c.Query("service")
	limit := 100

	traces, err := s.jaegerClient.QueryTraces(c.Request.Context(), map[string]interface{}{
		"service": service,
		"error":   true,
		"limit":   limit,
	})

	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}

	c.JSON(http.StatusOK, traces)
}

// 服务依赖图
func (s *TraceAnalysisService) GetServiceDependencyGraph(c *gin.Context) {
	timeRange := c.DefaultQuery("range", "24h")
	
	graph, err := s.jaegerClient.GetDependencies(c.Request.Context(), timeRange)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}

	c.JSON(http.StatusOK, graph)
}
```

### 8. Jaeger 部署配置

```yaml
# infrastructure/jaeger/deployment.yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: jaeger
  namespace: monitoring
spec:
  replicas: 1
  selector:
    matchLabels:
      app: jaeger
  template:
    metadata:
      labels:
        app: jaeger
    spec:
      containers:
      - name: jaeger
        image: jaegertracing/all-in-one:1.52
        ports:
        - containerPort: 16686
          name: ui
        - containerPort: 14268
          name: collector-http
        - containerPort: 14250
          name: collector-grpc
        - containerPort: 6831
          name: agent-udp
          protocol: UDP
        env:
        - name: COLLECTOR_ZIPKIN_HOST_PORT
          value: ":9411"
        - name: SPAN_STORAGE_TYPE
          value: elasticsearch
        - name: ES_SERVER_URLS
          value: "http://elasticsearch:9200"
        - name: ES_INDEX_PREFIX
          value: "jaeger"
        resources:
          requests:
            cpu: 100m
            memory: 256Mi
          limits:
            cpu: 500m
            memory: 1Gi
---
apiVersion: v1
kind: Service
metadata:
  name: jaeger
  namespace: monitoring
spec:
  ports:
  - name: ui
    port: 16686
    targetPort: 16686
  - name: collector-http
    port: 14268
    targetPort: 14268
  - name: collector-grpc
    port: 14250
    targetPort: 14250
  selector:
    app: jaeger
---
# Elasticsearch for trace storage
apiVersion: apps/v1
kind: StatefulSet
metadata:
  name: elasticsearch
  namespace: monitoring
spec:
  serviceName: elasticsearch
  replicas: 1
  selector:
    matchLabels:
      app: elasticsearch
  template:
    metadata:
      labels:
        app: elasticsearch
    spec:
      containers:
      - name: elasticsearch
        image: docker.elastic.co/elasticsearch/elasticsearch:8.11.0
        ports:
        - containerPort: 9200
        env:
        - name: discovery.type
          value: single-node
        - name: ES_JAVA_OPTS
          value: "-Xms512m -Xmx512m"
        - name: xpack.security.enabled
          value: "false"
        resources:
          requests:
            cpu: 500m
            memory: 1Gi
          limits:
            cpu: 1000m
            memory: 2Gi
```

### 9. Grafana Trace 可视化面板

```json
{
  "dashboard": {
    "title": "mineGo Distributed Tracing",
    "panels": [
      {
        "title": "Request Duration Distribution",
        "type": "heatmap",
        "datasource": "Jaeger",
        "targets": [
          {
            "expr": "histogram_quantile(0.95, rate(http_request_duration_seconds_bucket[5m]))"
          }
        ]
      },
      {
        "title": "Top Slowest Services",
        "type": "bargauge",
        "datasource": "Jaeger",
        "targets": [
          {
            "expr": "topk(10, avg by (service) (trace_span_duration_ms))"
          }
        ]
      },
      {
        "title": "Error Rate by Service",
        "type": "timeseries",
        "datasource": "Jaeger",
        "targets": [
          {
            "expr": "sum by (service) (rate(trace_span_errors_total[5m])) / sum by (service) (rate(trace_spans_total[5m]))"
          }
        ]
      },
      {
        "title": "Service Dependency Graph",
        "type": "nodeGraph",
        "datasource": "Jaeger"
      },
      {
        "title": "Active Traces",
        "type": "stat",
        "datasource": "Jaeger",
        "targets": [
          {
            "expr": "count(traces_active_total)"
          }
        ]
      },
      {
        "title": "Sampling Rate",
        "type": "gauge",
        "datasource": "Jaeger",
        "targets": [
          {
            "expr": "rate(traces_sampled_total[5m]) / rate(traces_total[5m])"
          }
        ]
      }
    ]
  }
}
```

### 10. 配置文件

```yaml
# config/tracing.yaml
tracing:
  enabled: true
  service_name: "${SERVICE_NAME}"
  environment: "${ENVIRONMENT}"
  
  jaeger:
    endpoint: "http://jaeger.monitoring.svc.cluster.local:14268/api/traces"
    
  sampling:
    base_rate: 0.1  # 10% 基础采样率
    error_rate: 1.0  # 错误请求 100% 采样
    slow_trace_rate: 1.0  # 慢请求 100% 采样
    slow_threshold_ms: 1000
    
  propagators:
    - tracecontext  # W3C Trace Context
    - baggage       # W3C Baggage
    
  resource_attributes:
    deployment.environment: "${ENVIRONMENT}"
    service.version: "${SERVICE_VERSION}"
    service.namespace: "mineGo"
    
  limits:
    max_attributes_per_span: 128
    max_events_per_span: 128
    max_links_per_span: 128
    
  exporters:
    jaeger:
      enabled: true
      timeout: 10s
    logging:
      enabled: false  # 生产环境关闭
```

## 验收标准

- [ ] OpenTelemetry SDK 成功集成到所有微服务
- [ ] API Gateway 自动注入 Trace Context
- [ ] gRPC 服务间调用自动传播 Trace Context
- [ ] HTTP 服务间调用自动传播 Trace Context
- [ ] 数据库操作自动记录 Span
- [ ] Redis 操作自动记录 Span
- [ ] RabbitMQ/Kafka 消息自动传播 Trace Context
- [ ] 自适应采样器根据错误率动态调整采样率
- [ ] 错误请求 100% 被采样
- [ ] 慢请求（>1s）100% 被采样
- [ ] 高优先级操作 100% 被采样
- [ ] Jaeger 成功部署并接收 Trace 数据
- [ ] Trace 可视化界面正常显示调用链
- [ ] 服务依赖图正常生成
- [ ] Trace 分析服务能够查询慢 Trace
- [ ] Trace 分析服务能够查询错误 Trace
- [ ] Grafana 监控面板正常展示 Trace 指标
- [ ] Trace ID 正确返回到客户端响应头
- [ ] 单元测试覆盖率 ≥ 80%
- [ ] 端到端测试验证完整调用链追踪
- [ ] 性能测试验证追踪系统开销 < 5%
- [ ] 文档完整，包括使用指南和故障排查

## 影响范围

### 新增文件
- `backend/shared/tracing/tracer.go` - OpenTelemetry 初始化
- `backend/shared/tracing/sampler.go` - 自适应采样器
- `backend/shared/tracing/db_tracing.go` - 数据库追踪集成
- `backend/shared/tracing/redis_tracing.go` - Redis 追踪集成
- `backend/shared/tracing/context_propagation.go` - 上下文传播工具
- `backend/shared/middleware/tracing_middleware.go` - HTTP/gRPC 中间件
- `backend/services/trace-analysis-service/` - Trace 分析服务
- `infrastructure/jaeger/` - Jaeger 部署配置
- `config/tracing.yaml` - 追踪配置文件

### 修改文件
- `backend/shared/config/config.go` - 添加追踪配置结构
- `backend/shared/server/server.go` - 集成追踪中间件
- 所有微服务 main.go - 初始化追踪系统
- `infrastructure/kubernetes/` - 添加 Jaeger 部署
- `docs/architecture/observability.md` - 更新可观测性文档

### 依赖
- `go.opentelemetry.io/otel` (v1.21.0)
- `go.opentelemetry.io/otel/trace` (v1.21.0)
- `go.opentelemetry.io/otel/sdk` (v1.21.0)
- `go.opentelemetry.io/otel/exporters/jaeger` (v1.17.0)
- Jaeger (v1.52)
- Elasticsearch (v8.11.0) - Trace 存储

## 参考

- [OpenTelemetry 官方文档](https://opentelemetry.io/docs/)
- [Jaeger 官方文档](https://www.jaegertracing.io/docs/)
- [W3C Trace Context 规范](https://www.w3.org/TR/trace-context/)
- [OpenTelemetry Go SDK](https://github.com/open-telemetry/opentelemetry-go)
- [分布式追踪最佳实践](https://opentelemetry.io/docs/reference/specification/trace/sdk/)
