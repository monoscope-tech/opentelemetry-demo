// Copyright The OpenTelemetry Authors
// SPDX-License-Identifier: Apache-2.0
const grpc = require('@grpc/grpc-js')
const protoLoader = require('@grpc/proto-loader')
const health = require('grpc-js-health-check')
const opentelemetry = require('@opentelemetry/api')
const { ATTR_ERROR_TYPE } = require('@opentelemetry/semantic-conventions')

const charge = require('./charge')
const logger = require('./logger')
const { observeGrpc } = require('@monoscopetech/common')

async function chargeServiceHandler(call, callback) {
  const span = opentelemetry.trace.getActiveSpan();

  try {
    const amount = call.request.amount
    span?.setAttributes({
      'demo.payment.amount': (Number(amount.units) + amount.nanos / 1000000000).toFixed(2)
    })
    logger.info("Charge request received.")

    const response = await charge.charge(call.request)
    callback(null, response)

  } catch (err) {
    logger.warn({ err })

    span?.setStatus({ code: opentelemetry.SpanStatusCode.ERROR, message: err.message })
    span?.setAttribute(ATTR_ERROR_TYPE, err.name || 'Error')
    callback(err)
  }
}

async function closeGracefully(signal) {
  server.forceShutdown()
  process.kill(process.pid, signal)
}

const otelDemoPackage = grpc.loadPackageDefinition(protoLoader.loadSync('demo.proto'))
const server = new grpc.Server()

server.addService(health.service, new health.Implementation({
  '': health.servingStatus.SERVING
}))

// Payload capture comes from the SDK rather than from a hand-written interceptor in this
// repo: redaction then follows the same JSONPath config every other Monoscope integration
// takes, and the span contract lives in one place instead of being reproduced per service.
//
// The card fields are redacted because this demo is public and the charge request carries a
// real-looking card. `$..` rather than fixed paths — the card sits at one depth on the request
// and another where it is echoed back, and a path that misses is indistinguishable from a
// field that was not there.
server.addService(otelDemoPackage.oteldemo.PaymentService.service, {
  charge: observeGrpc({
    method: '/oteldemo.PaymentService/Charge',
    captureRequestBody: true,
    captureResponseBody: true,
    redactRequestBody: [
      '$..creditCardNumber',
      '$..creditCardCvv',
      '$..creditCardExpirationYear',
      '$..creditCardExpirationMonth',
    ],
    redactResponseBody: ['$..creditCardNumber', '$..creditCardCvv'],
  }, chargeServiceHandler),
})


let ip = "0.0.0.0";

const ipv6_enabled = process.env.IPV6_ENABLED;

if (ipv6_enabled == "true") {
  ip = "[::]";
  logger.info(`Overwriting Localhost IP: ${ip}`)
}

const address = ip + `:${process.env['PAYMENT_PORT']}`;

server.bindAsync(address, grpc.ServerCredentials.createInsecure(), (err, port) => {
  if (err) {
    return logger.error({ err })
  }

  server.start()
  logger.info(`payment gRPC server started on ${address}`)
})

process.once('SIGINT', closeGracefully)
process.once('SIGTERM', closeGracefully)
