const foodicsAdapter = require('./foodicsAdapter');
const squareAdapter = require('./squareAdapter');
const zenotiAdapter = require('./zenotiAdapter');
const loyverseAdapter = require('./loyverseAdapter');
const freshaAdapter = require('./freshaAdapter');
const customPosAdapter = require('./customPosAdapter');

// Ordering-capable adapters (push a line-item order/receipt)
const ORDER_ADAPTERS = {
  foodics: foodicsAdapter,
  square: squareAdapter,
  loyverse: loyverseAdapter,
  custom: customPosAdapter, // the no-code generic connector
};

// Booking-capable adapters (push an appointment/service booking)
const BOOKING_ADAPTERS = {
  zenoti: zenotiAdapter,
  fresha: freshaAdapter,
  square: squareAdapter, // has a documented Bookings API too, not yet implemented here - see squareAdapter.js
};

// Pushes an order to whichever POS provider a business has configured for
// ordering. Returns a consistent { success, externalOrderId?, error? }
// shape regardless of which adapter actually handled it.
async function pushOrderToPos(provider, config, order, items) {
  const adapter = ORDER_ADAPTERS[provider];
  if (!adapter || !adapter.pushOrder) {
    return { success: false, error: `No order-push adapter available for provider "${provider}"` };
  }
  return adapter.pushOrder(config, order, items);
}

// Pushes a booking to whichever provider a business has configured for
// booking integration.
async function pushBookingToPos(provider, config, booking) {
  const adapter = BOOKING_ADAPTERS[provider];
  if (!adapter || !adapter.pushBooking) {
    return { success: false, error: `No booking-push adapter available for provider "${provider}"` };
  }
  return adapter.pushBooking(config, booking);
}

module.exports = { pushOrderToPos, pushBookingToPos };
