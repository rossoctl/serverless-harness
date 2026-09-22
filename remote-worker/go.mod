module github.com/kagenti/serverless-harness/remote-worker

go 1.26.0

require (
	github.com/kagenti/serverless-harness/gen/go v0.0.0
	golang.org/x/sys v0.48.0
	google.golang.org/grpc v1.84.0
)

require (
	golang.org/x/net v0.58.0 // indirect
	golang.org/x/text v0.41.0 // indirect
	google.golang.org/genproto/googleapis/rpc v0.0.0-20260706201446-f0a921348800 // indirect
	google.golang.org/protobuf v1.36.12 // indirect
)

// Use the proto stubs vendored in this repo.
replace github.com/kagenti/serverless-harness/gen/go => ../gen/go
