export default {
  timeout: 60_000,
  expect: {timeout: 10_000},
  workers: 1,
  retries: 0,
  use: {headless: true, trace: "retain-on-failure", screenshot: "only-on-failure"},
}
