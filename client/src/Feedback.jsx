import Markdown from 'react-markdown'
import remarkGfm from 'remark-gfm'

export default function Feedback({ children }) {
  return <div className="markdown-feedback"><Markdown remarkPlugins={[remarkGfm]} skipHtml components={{
    img: ({ alt }) => <span>{alt}</span>,
    table: ({ children }) => <div className="feedback-table"><table>{children}</table></div>,
  }}>{children}</Markdown></div>
}
