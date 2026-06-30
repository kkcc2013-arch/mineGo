'use strict';

const { createEventBus } = require('./EventBusAdapter');
const eventBus = createEventBus();

async function produceEvent(topic, event, options) {
  return eventBus.publish(topic, event, options);
}

module.exports = { produceEvent };
