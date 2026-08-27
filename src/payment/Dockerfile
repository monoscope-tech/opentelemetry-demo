# Copyright The OpenTelemetry Authors
# SPDX-License-Identifier: Apache-2.0


FROM docker.io/library/node:26.4.0-slim@sha256:a1d9d671994fc2d26e297ac56b4b1522a8bc7fa71c43b14cd1b1fe6c5116f7dc AS builder

WORKDIR /usr/src/app/

COPY ./src/payment/package.json package.json
COPY ./src/payment/package-lock.json package-lock.json

RUN npm ci --omit=dev

# -----------------------------------------------------------------------------

FROM gcr.io/distroless/nodejs22-debian12:nonroot@sha256:13593b7570658e8477de39e2f4a1dd25db2f836d68a0ba771251572d23bb4f8e

WORKDIR /usr/src/app/

COPY --from=builder /usr/src/app/node_modules/ node_modules/

COPY ./pb/demo.proto demo.proto

# Every source file is copied by name, so a new module is invisible to the image until it is
# listed here — and the failure is a crash loop at startup, not a build error.
COPY ./src/payment/charge.js charge.js
COPY ./src/payment/index.js index.js
COPY ./src/payment/logger.js logger.js
COPY ./src/payment/monoscope.js monoscope.js

EXPOSE ${PAYMENT_PORT}

CMD ["index.js"]
