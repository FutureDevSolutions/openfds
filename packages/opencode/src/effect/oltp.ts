import * as NodeSdk from "@effect/opentelemetry/NodeSdk"
import * as OtelResource from "@effect/opentelemetry/Resource"
import * as OtelTracer from "@effect/opentelemetry/Tracer"
import { context, trace, type AttributeValue, type Span, type Tracer } from "@opentelemetry/api"
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-http"
import { BatchSpanProcessor } from "@opentelemetry/sdk-trace-base"
import { Duration, Effect, Layer, ManagedRuntime, Option } from "effect"
import * as Context from "effect/Context"
import { FetchHttpClient } from "effect/unstable/http"
import { OtlpLogger, OtlpSerialization, OtlpTracer } from "effect/unstable/observability"
import { normalizeServerUrl } from "@/account/url"
import { EffectLogger } from "@/effect/logger"
import { Flag } from "@/flag/flag"
import { CHANNEL, VERSION } from "@/installation/meta"

export namespace Observability {
  export class AITracer extends Context.Service<AITracer, Tracer>()("@opencode/Observability/AITracer") {}

  const clean = <T extends Record<string, unknown>>(value: T) =>
    Object.fromEntries(Object.entries(value).filter((entry) => entry[1] !== undefined)) as {
      [K in keyof T as undefined extends T[K] ? never : K]: Exclude<T[K], undefined>
    }

  const parseHeaders = () =>
    Flag.OTEL_EXPORTER_OTLP_HEADERS
      ? Flag.OTEL_EXPORTER_OTLP_HEADERS.split(",").reduce(
          (acc, item) => {
            const at = item.indexOf("=")
            if (at < 1 || at === item.length - 1) return acc
            acc[item.slice(0, at)] = item.slice(at + 1)
            return acc
          },
          {} as Record<string, string>,
        )
      : undefined

  const base = Flag.OTEL_EXPORTER_OTLP_ENDPOINT
  const root = base ? normalizeServerUrl(base) : undefined
  const traces = Flag.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT ?? (root ? `${root}/v1/traces` : undefined)
  const logs = Flag.OTEL_EXPORTER_OTLP_LOGS_ENDPOINT ?? (root ? `${root}/v1/logs` : undefined)

  export const enabled = !!traces || !!logs

  const resource = {
    serviceName: "opencode",
    serviceVersion: VERSION,
    attributes: {
      "deployment.environment.name": CHANNEL === "local" ? "local" : CHANNEL,
      "opencode.client": Flag.OPENCODE_CLIENT,
    },
  }

  const headers = parseHeaders()

  const tracer = traces
    ? OtlpTracer.layer({
        url: traces,
        resource,
        headers,
      })
    : Layer.empty

  const logger = logs
    ? OtlpLogger.layer({
        url: logs,
        resource,
        headers,
        exportInterval: Duration.seconds(1),
        mergeWithExisting: true,
      })
    : Layer.empty

  const ai = traces
    ? Layer.effect(AITracer, Effect.service(OtelTracer.OtelTracer)).pipe(
        Layer.provide(
          OtelTracer.layerTracer.pipe(
            Layer.provide(
              NodeSdk.layerTracerProvider(new BatchSpanProcessor(new OTLPTraceExporter({ url: traces, headers }))),
            ),
            Layer.provide(OtelResource.layer(resource)),
          ),
        ),
      )
    : Layer.succeed(AITracer, trace.getTracer(resource.serviceName, resource.serviceVersion))

  export const layer =
    !traces && !logs
      ? Layer.mergeAll(EffectLogger.layer, ai)
      : Layer.mergeAll(tracer, logger, ai).pipe(
          Layer.provide(EffectLogger.layer),
          Layer.provide(OtlpSerialization.layerJson),
          Layer.provide(FetchHttpClient.layer),
        )

  const runtime = ManagedRuntime.make(layer)
  const aiRuntime = ManagedRuntime.make(ai)

  const withSpan = <A>(span: Option.Option<Span>, fn: () => A): A =>
    Option.match(span, {
      onNone: fn,
      onSome: (span) => context.with(trace.setSpan(context.active(), span), fn),
    })

  const withActiveParent = <A, E, R>(effect: Effect.Effect<A, E, R>) => {
    const active = trace.getActiveSpan()
    if (!active) return effect
    return effect.pipe(OtelTracer.withSpanContext(active.spanContext()))
  }

  export const runPromise = <A, E>(effect: Effect.Effect<A, E>) => runtime.runPromise(withActiveParent(effect))

  export const runFork = <A, E>(effect: Effect.Effect<A, E>) => runtime.runFork(withActiveParent(effect))

  export const promise = <A>(fn: (tracer: Tracer) => Promise<A> | A) =>
    Effect.gen(function* () {
      const span = yield* Effect.option(OtelTracer.currentOtelSpan)
      const tracer = yield* Effect.promise(() => aiRuntime.runPromise(Effect.service(AITracer)))
      return yield* Effect.promise(() => Promise.resolve(withSpan(span, () => fn(tracer))))
    })

  export const aiTelemetry = (input: {
    enabled: boolean | undefined
    tracer: Tracer
    functionId: string
    metadata?: Record<string, AttributeValue | undefined>
  }) => {
    if (!input.enabled || !traces) return { isEnabled: false as const }
    return {
      isEnabled: true as const,
      functionId: input.functionId,
      tracer: input.tracer,
      metadata: input.metadata ? clean(input.metadata) : undefined,
    }
  }
}
