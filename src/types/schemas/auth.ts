import { z } from "zod";

export const loginBodySchema = z.object({
  email: z.string().email("Invalid email").min(1, "Email required"),
  password: z.string().min(1, "Password required"),
});

export type LoginBody = z.infer<typeof loginBodySchema>;

export const loginSuccessSchema = z.object({
  success: z.literal(true),
});

export type LoginSuccess = z.infer<typeof loginSuccessSchema>;

export const changePasswordBodySchema = z.object({
  currentPassword: z.string().min(1, "currentPassword is required"),
  newPassword: z.string().min(1, "newPassword is required"),
});

export type ChangePasswordBody = z.infer<typeof changePasswordBodySchema>;
