# bash completion for nk — source from ~/.bashrc (install.sh does this).
_nk_complete() {
  local cur prev cmds stacks
  cur=${COMP_WORDS[COMP_CWORD]}
  prev=${COMP_WORDS[COMP_CWORD-1]}
  cmds="up down restart status attach logs kill list init rename ports stats chat send secret nopass show token curl mk web help"

  if [ "$COMP_CWORD" -eq 1 ]; then
    mapfile -t COMPREPLY < <(compgen -W "$cmds" -- "$cur")
    return
  fi

  # Ask nk itself, so stacks defined in the current project show up too.
  case $prev in
    up|attach|logs|restart|status|token|ports|send|secret|show|rename|chat)
      stacks=$(nk list -n 2>/dev/null)
      mapfile -t COMPREPLY < <(compgen -W "$stacks" -- "$cur") ;;
    down)
      stacks=$(nk list -n 2>/dev/null)
      mapfile -t COMPREPLY < <(compgen -W "$stacks all" -- "$cur") ;;
    -s|--stack)
      stacks=$(nk list -n 2>/dev/null)
      mapfile -t COMPREPLY < <(compgen -W "$stacks" -- "$cur") ;;
    curl)
      mapfile -t COMPREPLY < <(compgen -W "-s GET POST PUT PATCH DELETE" -- "$cur") ;;
    mk)
      mapfile -t COMPREPLY < <(compgen -W "-s" -- "$cur") ;;
  esac
}
complete -F _nk_complete nk
