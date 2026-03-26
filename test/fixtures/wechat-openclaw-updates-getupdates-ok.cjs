module.exports = {
  getUpdates: async (params) => ({
    msgs: Array.isArray(params?.msgs) ? params.msgs : [],
    get_updates_buf: "buf-from-fixture",
  }),
}
