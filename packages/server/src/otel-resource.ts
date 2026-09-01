import { resourceFromAttributes } from '@opentelemetry/resources'
import { appVersion } from './platform/paths'

/** What this process calls itself in every signal it emits. Traces, logs and
 *  metrics leave from three different providers and must name one service, so
 *  the identity lives beside them rather than inside any one of them. */
export function otelResource() {
  return resourceFromAttributes({
    'service.name': 'solus',
    'service.version': appVersion(),
  })
}
