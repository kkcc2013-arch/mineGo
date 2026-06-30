'use strict';

const { createEventBus } = require('./EventBusAdapter');
const eventBus = createEventBus();

async function sendKafkaEvent(topic, event, options) {
  return eventBus.publish(topic, event, options);
}

module.exports = { sendKafkaEvent };
