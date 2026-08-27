<?php
// Copyright The OpenTelemetry Authors
// SPDX-License-Identifier: Apache-2.0



declare(strict_types=1);

use DI\Bridge\Slim\Bridge;
use DI\ContainerBuilder;
use OpenTelemetry\API\Globals;
use OpenTelemetry\SDK\Common\Configuration\Configuration;
use OpenTelemetry\SDK\Common\Configuration\Variables;
use OpenTelemetry\SDK\Logs\LoggerProviderInterface;
use OpenTelemetry\SDK\Metrics\MeterProviderInterface;
use OpenTelemetry\SDK\Trace\TracerProviderInterface;
use Psr\Http\Message\ServerRequestInterface;
use React\EventLoop\Loop;
use React\Http\HttpServer;
use React\Socket\SocketServer;
use Slim\Factory\AppFactory;

require __DIR__ . '/../vendor/autoload.php';

// Instantiate PHP-DI ContainerBuilder
$containerBuilder = new ContainerBuilder();

// Set up settings
$settings = require __DIR__ . '/../app/settings.php';
$settings($containerBuilder);

// Set up dependencies
$dependencies = require __DIR__ . '/../app/dependencies.php';
$dependencies($containerBuilder);

// Build PHP-DI Container instance
$container = $containerBuilder->build();

// Instantiate the app
AppFactory::setContainer($container);
$app = Bridge::create($container);

// Monoscope: capture request/response payloads on the span.
//
// Registered BEFORE the routing and body-parsing middleware, which means it runs AFTER
// them: Slim's add() prepends, so the last middleware added is the outermost and executes
// first. This one therefore sits innermost, by which point routing has resolved (the SDK
// reads RouteContext for the matched pattern — calling it any earlier throws "Cannot
// create RouteContext before routing has been completed") and the body has been parsed.
//
// It composes with the OTel setup already in this service: the middleware takes the ambient
// tracer from Globals::tracerProvider() and adds no exporter of its own.
//
// Redaction is by JSONPath and runs before the body reaches the span. The quote service
// receives shipping dimensions and an address; the address is a real one, so it is redacted
// rather than shipped.
$app->add(new \APIToolkit\APIToolkitMiddleware([
    'captureRequestBody' => true,
    'captureResponseBody' => true,
    'redactHeaders' => ['authorization', 'cookie', 'x-api-key'],
    'redactRequestBody' => ['$..address', '$..streetAddress', '$..zipCode', '$..email'],
    'redactResponseBody' => ['$..address', '$..streetAddress', '$..zipCode', '$..email'],
]));

// Register middleware
$app->addRoutingMiddleware();

// Register routes
$routes = require __DIR__ . '/../app/routes.php';
$routes($app);

// Add Body Parsing Middleware
$app->addBodyParsingMiddleware();

// Add Error Middleware
$errorMiddleware = $app->addErrorMiddleware(true, true, true);
// Drain before exiting, rather than exiting the instant SIGTERM lands.
//
// Kubernetes removes a terminating pod from the Service endpoints asynchronously, and that
// removal races the container exiting. Whichever loses, the loser is this process: kube-proxy
// keeps DNAT-ing new connections here for a moment after SIGTERM, and if nothing is bound the
// packets are dropped rather than refused. The caller does not see a connection error it can
// retry — it sees nothing at all, and gives up at its own deadline.
//
// That is what shipping's 5s timeouts against /getquote were: every one landed within ~30s of
// a quote rollout, including a rollout that was reverting *to* the uninstrumented image, and
// none landed while the service was simply serving traffic. Startup is not the gap — this
// container answers in 0.19s — the teardown is.
//
// So keep the loop running, and keep serving, for long enough that endpoint removal has
// certainly propagated, then exit. terminationGracePeriodSeconds is 30, so this stays well
// inside the budget kubernetes allows before it sends SIGKILL.
Loop::get()->addSignal(SIGTERM, function() {
    Loop::addTimer(15, function() {
        exit;
    });
});

/* workaround for non-async batch processors */
if (($tracerProvider = Globals::tracerProvider()) instanceof TracerProviderInterface) {
    Loop::addPeriodicTimer(Configuration::getInt(Variables::OTEL_BSP_SCHEDULE_DELAY)/1000, function() use ($tracerProvider) {
        $tracerProvider->forceFlush();
    });
}
if (($loggerProvider = Globals::loggerProvider()) instanceof LoggerProviderInterface) {
    Loop::addPeriodicTimer(Configuration::getInt(Variables::OTEL_BLRP_SCHEDULE_DELAY)/1000, function() use ($loggerProvider) {
        $loggerProvider->forceFlush();
    });
}
if (($meterProvider = Globals::meterProvider()) instanceof MeterProviderInterface) {
    Loop::addPeriodicTimer(Configuration::getInt(Variables::OTEL_METRIC_EXPORT_INTERVAL)/1000, function() use ($meterProvider) {
        $meterProvider->forceFlush();
    });
}

$server = new HttpServer(function (ServerRequestInterface $request) use ($app) {
    $response = $app->handle($request);
    echo sprintf('[%s] "%s %s HTTP/%s" %d %d %s',
        date('Y-m-d H:i:sP'),
        $request->getMethod(),
        $request->getUri()->getPath(),
        $request->getProtocolVersion(),
        $response->getStatusCode(),
        $response->getBody()->getSize(),
        PHP_EOL,
    );

    return $response;
});

$ip = "0.0.0.0";

$ipv6_enabled = getenv('IPV6_ENABLED');

if ($ipv6_enabled == "true") {
    $ip = "[::]";
    echo "Overwriting Localhost IP: {$ip}" . PHP_EOL;
} 

$address = $ip . ':' . getenv('QUOTE_PORT');

$socket = new SocketServer($address);
$server->listen($socket);

echo "Listening on: {$address}" . PHP_EOL;
