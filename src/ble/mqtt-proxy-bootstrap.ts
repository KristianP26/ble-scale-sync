import type { MqttProxyConfig } from '../config/schema.js';
import { startEmbeddedBroker, type EmbeddedBrokerHandle } from './embedded-broker.js';

export interface MqttProxyBootstrapResult {
  /** Effective config with `broker_url` guaranteed to be set. */
  mqttProxy: MqttProxyConfig;
  /** Embedded broker handle (lifecycle owned by caller) if one was started, else null. */
  embeddedBroker: EmbeddedBrokerHandle | null;
}

/**
 * Prepare the MQTT proxy for use.
 *
 * If `broker_url` is already configured, this is a no-op and the same config
 * is returned. Otherwise an embedded aedes broker is started on the configured
 * port and the returned config's `broker_url` points at the loopback listener.
 *
 * Note on credentials: `username` and `password` are forwarded verbatim. A null
 * password with a set username is treated as an empty string by the broker's
 * authenticator (both sides must agree), so avoid this combination in configs.
 *
 * The caller owns the embedded broker handle and must call `close()` during
 * shutdown.
 */
export async function bootstrapMqttProxy(
  mqttProxy: MqttProxyConfig,
): Promise<MqttProxyBootstrapResult> {
  if (mqttProxy.broker_url) {
    return { mqttProxy, embeddedBroker: null };
  }

  const embeddedBroker = await startEmbeddedBroker({
    port: mqttProxy.embedded_broker_port,
    bindHost: mqttProxy.embedded_broker_bind,
    username: mqttProxy.username,
    password: mqttProxy.password,
    topicPrefix: mqttProxy.topic_prefix,
  });

  return {
    mqttProxy: { ...mqttProxy, broker_url: embeddedBroker.url },
    embeddedBroker,
  };
}
