import * as React from "react"
import { EyeIcon, EyeOffIcon } from "lucide-react"

import {
  InputGroup,
  InputGroupAddon,
  InputGroupButton,
  InputGroupInput,
} from "@/components/ui/input-group"

interface InputPasswordProps
  extends Omit<React.ComponentProps<typeof InputGroupInput>, "type"> {
  inputGroupClassName?: string
  leadingIcon?: React.ReactNode
}

const InputPassword = React.forwardRef<HTMLInputElement, InputPasswordProps>(
  function InputPassword(
    { inputGroupClassName, leadingIcon, ...props },
    ref,
  ) {
    const [visible, setVisible] = React.useState(false)
    const visibilityLabel = visible ? "隐藏明文" : "查看明文"

    return (
      <InputGroup className={inputGroupClassName}>
        {leadingIcon ? <InputGroupAddon>{leadingIcon}</InputGroupAddon> : null}
        <InputGroupInput ref={ref} type={visible ? "text" : "password"} {...props} />
        <InputGroupAddon align="inline-end">
          <InputGroupButton
            size="icon-xs"
            title={visibilityLabel}
            aria-label={visibilityLabel}
            onClick={() => setVisible((nextVisible) => !nextVisible)}
          >
            {visible ? <EyeOffIcon /> : <EyeIcon />}
          </InputGroupButton>
        </InputGroupAddon>
      </InputGroup>
    )
  },
)
InputPassword.displayName = "InputPassword"

export { InputPassword }
