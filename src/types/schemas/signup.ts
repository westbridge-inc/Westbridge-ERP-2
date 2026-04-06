import { z } from "zod";

export const signupBodySchema = z.object({
  email: z.string().email("Invalid email").min(1, "Email required"),
  name: z.string().min(1, "Name required").max(200),
  password: z.string().min(8, "Password must be at least 8 characters").max(200),
  companyName: z.string().min(1, "Company name required").max(200),
  plan: z.string().min(1, "Plan required"),
  modulesSelected: z.array(z.string()).optional().default([]),
});

export type SignupBody = z.infer<typeof signupBodySchema>;

export const signupSuccessSchema = z.object({
  accountId: z.string(),
  paymentUrl: z.string().nullable(),
  status: z.literal("pending"),
  message: z.string().optional(),
});

export type SignupSuccess = z.infer<typeof signupSuccessSchema>;
