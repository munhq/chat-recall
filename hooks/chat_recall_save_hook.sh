#!/usr/bin/env bash
# chat-recall save hook — auto-saves memory every 15 messages
# Installed as a Claude Code hook in ~/.claude/hooks.json
#
# This hook fires every 15 messages during a session.
# It extracts key facts (decisions, topics, tools) and saves them
# so they're preserved even if the session ends unexpectedly.
#
# Setup (one-time):
#   1. Copy this file to ~/.claude/chat-recall-hooks/
#   2. Add to ~/.claude/hooks.json:
#      {
#        "hooks": {
#          "Stop": [{"matcher": "", "hooks": [{"type": "command", "command": "/home/YOU/.claude/chat-recall-hooks/chat_recall_save_hook.sh"}]}],
#          "PreCompact": [{"matcher": "", "hooks": [{"type": "command", "command": "/home/YOU/.claude/chat-recall-hooks/chat_recall_save_hook.sh --precompact"}]}]
#        }
#      }

set -euo pipefail

HOOKS_DIR="${HOME}/.claude/chat-recall-hooks"
MEMORY_DIR="${HOME}/.claude/chat-recall-memory"
STATE_FILE="${MEMORY_DIR}/last_save.json"
SESSION_ID=""

log() {
    echo "[chat-recall-save] $(date +%H:%M:%S) $*" >&2
}

init() {
    mkdir -p "${MEMORY_DIR}"
    mkdir -p "${HOOKS_DIR}"
}

# Detect current session from transcript
detect_session() {
    local projects_dir="${HOME}/.claude/projects"
    
    # Find the most recently modified session file
    local latest_file=""
    local latest_time=0
    
    if [[ -d "$projects_dir" ]]; then
        for dir in "$projects_dir"/*/; do
            if [[ -d "$dir" ]]; then
                for file in "$dir"/*.jsonl; do
                    if [[ -f "$file" ]]; then
                        local mtime
                        mtime=$(stat -c %Y "$file" 2>/dev/null || stat -f %m "$file" 2>/dev/null || echo 0)
                        if [[ "$mtime" -gt "$latest_time" ]]; then
                            latest_time="$mtime"
                            latest_file="$file"
                        fi
                    fi
                done
            fi
        done
    fi
    
    if [[ -n "$latest_file" && -f "$latest_file" ]]; then
        SESSION_ID=$(basename "$latest_file" .jsonl)
    fi
}

# Extract key facts from a session file
extract_facts() {
    local session_file="$1"
    local session_id="$2"
    
    if [[ ! -f "$session_file" ]]; then
        echo "{}"
        return
    fi
    
    # Count messages
    local msg_count
    msg_count=$(wc -l < "$session_file" 2>/dev/null || echo 0)
    
    # Extract unique tools used
    local tools
    tools=$(grep -o '"type":"tool_use"' "$session_file" 2>/dev/null | wc -l | tr -d ' ')
    
    # Extract topics from first user message
    local first_topic
    first_topic=$(grep -m1 '"type":"user"' "$session_file" 2>/dev/null | \
        sed 's/.*"text":"//' | sed 's/".*//' | head -c 200 | tr -d '\n' | tr -d '"')
    
    # Extract decisions (heuristic)
    local decisions=""
    decisions=$(grep -i "decided\|chose\|going with\|recommend\|prefer" "$session_file" 2>/dev/null | \
        head -3 | sed 's/.*"text":"//' | sed 's/".*//' | head -c 300 | tr -d '\n')
    
    # Get project path
    local project_path=""
    for dir in "${HOME}"/.claude/projects/*/; do
        if [[ -d "$dir" && -f "${dir}${session_id}.jsonl" ]]; then
            project_path=$(echo "$dir" | sed "s|${HOME}/.claude/projects/||" | sed 's|/||g' | sed 's|^|/|')
            project_path=$(echo "$project_path" | sed "s|-|/|g")
            break
        fi
    done
    
    # Output JSON
    cat <<EOF
{
  "session_id": "$session_id",
  "project_path": "$project_path",
  "message_count": $msg_count,
  "tool_uses": $tools,
  "first_topic": "$(echo "$first_topic" | jq -Rs '.' 2>/dev/null || echo "\"$first_topic\"")",
  "decisions": "$(echo "$decisions" | jq -Rs '.' 2>/dev/null || echo "\"\"")",
  "saved_at": "$(date -Iseconds)"
}
EOF
}

# Count messages in current session
count_messages() {
    local session_file="$1"
    if [[ ! -f "$session_file" ]]; then
        echo 0
        return
    fi
    grep -c '"type":"user"\|\|"type":"assistant"' "$session_file" 2>/dev/null || echo 0
}

# Main save logic
do_save() {
    local precompact="${1:-false}"
    
    detect_session
    
    if [[ -z "$SESSION_ID" ]]; then
        log "No active session found"
        return
    fi
    
    # Find the session file
    local session_file=""
    for dir in "${HOME}"/.claude/projects/*/; do
        if [[ -f "${dir}${SESSION_ID}.jsonl" ]]; then
            session_file="${dir}${SESSION_ID}.jsonl"
            break
        fi
    done
    
    if [[ -z "$session_file" || ! -f "$session_file" ]]; then
        log "Session file not found for $SESSION_ID"
        return
    fi
    
    # Extract and save facts
    local facts
    facts=$(extract_facts "$session_file" "$SESSION_ID")
    
    local output_file="${MEMORY_DIR}/sessions/${SESSION_ID}.json"
    mkdir -p "$(dirname "$output_file")"
    
    # Merge with existing data if present
    if [[ -f "$output_file" ]]; then
        # Simple merge: update fields but preserve accumulated data
        local existing_msg_count
        existing_msg_count=$(jq -r '.accumulated_messages // 0' "$output_file" 2>/dev/null || echo 0)
        local new_msg_count
        new_msg_count=$(echo "$facts" | jq -r '.message_count')
        local total_msgs=$((existing_msg_count + new_msg_count))
        
        # Update but preserve accumulated decisions
        local existing_decisions
        existing_decisions=$(jq -r '.accumulated_decisions // []' "$output_file" 2>/dev/null || echo '[]')
        
        echo "$facts" | jq --argjson decisions "$existing_decisions" --argjson total "$total_msgs" \
            '. + {accumulated_messages: $total, accumulated_decisions: $decisions}' > "$output_file"
    else
        echo "$facts" | jq '. + {accumulated_messages: .message_count, accumulated_decisions: []}' > "$output_file"
    fi
    
    # Track this save
    echo "{\"session_id\": \"$SESSION_ID\", \"saved_at\": \"$(date -Iseconds)\", \"precompact\": $precompact}" > "${STATE_FILE}"
    
    if [[ "$precompact" == "true" ]]; then
        log "[PRECOMPACT] Emergency save for $SESSION_ID"
    else
        log "Saved facts for $SESSION_ID ($(echo "$facts" | jq -r '.message_count') messages)"
    fi
}

# Check if we should save (throttle to avoid too frequent saves)
should_save() {
    local session_file="$1"
    
    if [[ ! -f "${STATE_FILE}" ]]; then
        return 0
    fi
    
    # Check last save time
    local last_save
    last_save=$(jq -r '.saved_at // empty' "${STATE_FILE}" 2>/dev/null || echo "")
    
    if [[ -z "$last_save" ]]; then
        return 0
    fi
    
    # Don't save more than once per 30 seconds
    local last_save_epoch
    last_save_epoch=$(date -d "$last_save" +%s 2>/dev/null || echo 0)
    local now_epoch
    now_epoch=$(date +%s)
    
    if (( now_epoch - last_save_epoch < 30 )); then
        return 1
    fi
    
    return 0
}

main() {
    init
    
    local precompact="false"
    if [[ "${1:-}" == "--precompact" ]]; then
        precompact="true"
    fi
    
    detect_session
    
    if [[ -z "$SESSION_ID" ]]; then
        log "No session detected, skipping"
        exit 0
    fi
    
    # Find session file
    local session_file=""
    for dir in "${HOME}"/.claude/projects/*/; do
        if [[ -f "${dir}${SESSION_ID}.jsonl" ]]; then
            session_file="${dir}${SESSION_ID}.jsonl"
            break
        fi
    done
    
    if [[ -z "$session_file" ]]; then
        log "Session file not found"
        exit 1
    fi
    
    if ! should_save "$session_file"; then
        log "Throttled (recent save)"
        exit 0
    fi
    
    do_save "$precompact"
}

main "$@"
