async function request(path, options = {}) {
  const response = await fetch(path, {
    ...options,
    headers: {
      ...(options.body ? { 'Content-Type': 'application/json' } : {}),
      ...options.headers,
    },
  })

  if (!response.ok) {
    let message = `Request failed (${response.status})`
    try {
      const body = await response.json()
      message = body.error || body.message || message
    } catch {
      // The status code still gives the user a useful error if no JSON was returned.
    }
    throw new Error(message)
  }

  if (response.status === 204) return null
  return response.json()
}

export const api = {
  async listConfigurations() {
    const data = await request('/api/configurations')
    return Array.isArray(data) ? data : data.configurations ?? []
  },

  async createConfiguration(settings) {
    const data = await request('/api/configurations', {
      method: 'POST',
      body: JSON.stringify(settings),
    })
    return data.configuration ?? data
  },

  async updateConfiguration(id, settings) {
    const data = await request(`/api/configurations/${encodeURIComponent(id)}`, {
      method: 'PUT',
      body: JSON.stringify(settings),
    })
    return data.configuration ?? data
  },

  async deleteConfiguration(id) {
    return request(`/api/configurations/${encodeURIComponent(id)}`, { method: 'DELETE' })
  },

  async listConfigurationConversations(id) {
    const data = await request(`/api/configurations/${encodeURIComponent(id)}/conversations`)
    return Array.isArray(data) ? data : data.conversations ?? []
  },

  async startConversation(configurationId) {
    const data = await request(`/api/configurations/${encodeURIComponent(configurationId)}/start`, {
      method: 'POST',
    })
    return data.conversation ?? data
  },

  async getConversation(id) {
    const data = await request(`/api/conversations/${encodeURIComponent(id)}`)
    return data.conversation ?? data
  },

  async deleteConversation(id) {
    return request(`/api/conversations/${encodeURIComponent(id)}`, { method: 'DELETE' })
  },

  async sendMessage(id, content) {
    const data = await request(`/api/conversations/${encodeURIComponent(id)}/messages`, {
      method: 'POST',
      body: JSON.stringify({ content }),
    })
    return data
  },

  async transcribeAudio(id, inputAudio) {
    return request(`/api/conversations/${encodeURIComponent(id)}/transcriptions`, {
      method: 'POST',
      body: JSON.stringify({ inputAudio }),
    })
  },

  async reviewAnswer(id, questionId, answer) {
    return request(`/api/conversations/${encodeURIComponent(id)}/reviews`, {
      method: 'POST',
      body: JSON.stringify({ questionId, answer }),
    })
  },
}
