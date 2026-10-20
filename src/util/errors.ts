export function errorMessage(error: unknown): string {
	if (error instanceof Error) {
		return error.message;
	}
	if (typeof error === 'string') {
		return error;
	}
	return String(error);
}

export function asError(error: unknown): Error {
	return error instanceof Error ? error : new Error(errorMessage(error));
}
