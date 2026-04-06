/**
 * Message renderer with syntax highlighting.
 */

import React from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { Prism as SyntaxHighlighter } from 'react-syntax-highlighter';
import { vscDarkPlus } from 'react-syntax-highlighter/dist/esm/styles/prism';
import type { Message } from '../services/api';
import './MessageRenderer.css';

interface MessageRendererProps {
  message: Message;
}

export default function MessageRenderer({ message }: MessageRendererProps) {
  const renderContent = () => {
    if (!message.content) return null;

    return (
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          code({ className, children, ...props }) {
            const match = /language-(\w+)/.exec(className || '');
            const isBlock = String(children).includes('\n');
            if (match && isBlock) {
              return (
                <SyntaxHighlighter
                  language={match[1]}
                  style={vscDarkPlus}
                  customStyle={{ margin: '0.5rem 0', borderRadius: '6px' }}
                >
                  {String(children).replace(/\n$/, '')}
                </SyntaxHighlighter>
              );
            }
            return <code className={className} {...props}>{children}</code>;
          },
        }}
      >
        {message.content}
      </ReactMarkdown>
    );
  };

  return (
    <div className={`message message-${message.role}`}>
      <div className="message-header">
        <span className="message-role">{message.role}</span>
        <span className="message-line">Line {message.line}</span>
      </div>

      {message.thinking && (
        <details className="thinking-block">
          <summary>Thinking...</summary>
          <div className="thinking-content">
            <pre>{message.thinking}</pre>
          </div>
        </details>
      )}

      <div className="message-content">{renderContent()}</div>

      {message.toolCalls && message.toolCalls.length > 0 && (
        <div className="tool-calls">
          <div className="tool-calls-header">Tool Calls:</div>
          {message.toolCalls.map((tool, idx) => (
            <details key={idx} className="tool-call">
              <summary>{tool.name}</summary>
              <div className="tool-call-content">
                <div className="tool-input">
                  <strong>Input:</strong>
                  <pre>{JSON.stringify(tool.input, null, 2)}</pre>
                </div>
                {tool.result && (
                  <div className="tool-result">
                    <strong>Result:</strong>
                    <pre>{JSON.stringify(tool.result, null, 2)}</pre>
                  </div>
                )}
              </div>
            </details>
          ))}
        </div>
      )}
    </div>
  );
}
