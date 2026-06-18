# ---- build ----
FROM golang:1.22-alpine AS build
WORKDIR /app
COPY src/ ./
RUN CGO_ENABLED=0 go build -trimpath -ldflags="-s -w" -o /reelhook .

# ---- run ----
FROM alpine:3.20
RUN adduser -D -u 10001 app
COPY --from=build /reelhook /usr/local/bin/reelhook
USER app
EXPOSE 8080
ENTRYPOINT ["reelhook"]
